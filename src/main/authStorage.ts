import { app, ipcMain, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { IpcMainInvokeEvent } from 'electron'
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CredentialStoreSnapshot,
  SaveCredentialResult,
  SavedCredential
} from '../shared/authStorage'

const STORE_VERSION = 1
const STORE_FILENAME = 'auth-credentials.bin'
// 同一 Windows 用户下最多保留的账号凭证数量，避免无上限增长
const MAX_CREDENTIALS = 10

// 墓碑：记录已登出 Token 的哈希，防止本地凭证暂时无法解密时旧 Token 复活
const TOMBSTONE_FILENAME = 'auth-credentials.tombstones.json'
const TOMBSTONE_VERSION = 1
const MAX_TOMBSTONES = 50
// Refresh Token 最长有效期 30 天，墓碑最多保留 31 天
const MAX_TOMBSTONE_AGE_MS = 31 * 24 * 60 * 60 * 1000
// 即使传入的过期时间已过，也至少保留 1 小时，避免过早失效
const MIN_TOMBSTONE_AGE_MS = 60 * 60 * 1000
// 墓碑可能被多个 Electron 实例同时追加，需要用锁文件保护「读-合并-写」
const TOMBSTONE_LOCK_TIMEOUT_MS = 5_000
const TOMBSTONE_LOCK_STALE_MS = 10_000
const TOMBSTONE_LOCK_RETRY_MS = 15

const USER_ID_PATTERN = /^[1-9]\d*$/
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/

type StoredCredential = SavedCredential & { updatedAt: number }

type CredentialStore = {
  version: number
  activeUserId: string | null
  credentials: StoredCredential[]
}

type TombstoneEntry = {
  userId: string
  tokenHash: string
  createdAt: number
  expiresAt: number
}

function storePath(): string {
  return join(app.getPath('userData'), STORE_FILENAME)
}

function tombstonePath(): string {
  return join(app.getPath('userData'), TOMBSTONE_FILENAME)
}

function hashToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseCredential(value: unknown): StoredCredential | null {
  if (!isRecord(value)) {
    return null
  }

  const { userId, refreshToken, expiresAt, updatedAt } = value

  if (
    typeof userId !== 'string' ||
    !/^[1-9]\d*$/.test(userId) ||
    typeof refreshToken !== 'string' ||
    refreshToken.length < 20 ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt) ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt)
  ) {
    return null
  }

  return { userId, refreshToken, expiresAt, updatedAt }
}

function parseStore(raw: unknown): CredentialStore {
  if (!isRecord(raw) || raw.version !== STORE_VERSION) {
    return { version: STORE_VERSION, activeUserId: null, credentials: [] }
  }

  const credentials = Array.isArray(raw.credentials)
    ? raw.credentials
        .map(parseCredential)
        .filter((credential): credential is StoredCredential => credential !== null)
    : []

  const activeUserId =
    typeof raw.activeUserId === 'string' && /^[1-9]\d*$/.test(raw.activeUserId)
      ? raw.activeUserId
      : null

  return {
    version: STORE_VERSION,
    activeUserId: credentials.some((credential) => credential.userId === activeUserId)
      ? activeUserId
      : null,
    credentials
  }
}

function parseTombstone(value: unknown): TombstoneEntry | null {
  if (!isRecord(value)) {
    return null
  }

  const { userId, tokenHash, createdAt, expiresAt } = value

  if (
    typeof userId !== 'string' ||
    !USER_ID_PATTERN.test(userId) ||
    typeof tokenHash !== 'string' ||
    !TOKEN_HASH_PATTERN.test(tokenHash) ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt)
  ) {
    return null
  }

  return { userId, tokenHash, createdAt, expiresAt }
}

async function readTombstones(): Promise<TombstoneEntry[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(tombstonePath(), 'utf8'))

    if (!isRecord(raw) || raw.version !== TOMBSTONE_VERSION || !Array.isArray(raw.entries)) {
      return []
    }

    const now = Date.now()
    return raw.entries
      .map(parseTombstone)
      .filter((entry): entry is TombstoneEntry => entry !== null && entry.expiresAt > now)
  } catch {
    // 文件不存在或损坏：视为没有墓碑，不影响正常读取凭证
    return []
  }
}

async function writeTombstones(entries: TombstoneEntry[]): Promise<void> {
  const bounded = [...entries]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_TOMBSTONES)
  const target = tombstonePath()
  const temporary = `${target}.tmp-${process.pid}`

  await writeFile(temporary, JSON.stringify({ version: TOMBSTONE_VERSION, entries: bounded }), {
    mode: 0o600
  })

  try {
    await rename(temporary, target)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      // 忽略清理失败
    }

    throw error
  }
}

function isTombstoned(entry: TombstoneEntry, credential: StoredCredential): boolean {
  return (
    entry.userId === credential.userId && entry.tokenHash === hashToken(credential.refreshToken)
  )
}

// 精确按 userId + Token 哈希过滤：只影响被登出的那个 Token，不影响其他实例/账号
function filterTombstoned(store: CredentialStore, tombstones: TombstoneEntry[]): CredentialStore {
  if (tombstones.length === 0) {
    return store
  }

  const credentials = store.credentials.filter(
    (credential) => !tombstones.some((entry) => isTombstoned(entry, credential))
  )

  if (credentials.length === store.credentials.length) {
    return store
  }

  return {
    version: store.version,
    activeUserId:
      store.activeUserId && credentials.some((item) => item.userId === store.activeUserId)
        ? store.activeUserId
        : null,
    credentials
  }
}

function emptyStore(): CredentialStore {
  return { version: STORE_VERSION, activeUserId: null, credentials: [] }
}

// 解密失败后的重试间隔：两个实例同时冷启动时，Windows safeStorage 的
// DPAPI 密钥可能尚未初始化完成，短暂等待后重试通常即可恢复
const DECRYPT_RETRY_DELAYS_MS = [0, 120, 320, 600]

// Windows Chromium OSCrypt 的密文前缀；缺少该前缀说明文件本身已损坏
const ENCRYPTED_PREFIX = Buffer.from('v10')

type StoreReadResult =
  | { kind: 'ok'; store: CredentialStore }
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'unreadable'; reason: string }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function looksLikeEncryptedStore(encrypted: Buffer): boolean {
  return (
    encrypted.length > ENCRYPTED_PREFIX.length + 16 &&
    encrypted.subarray(0, ENCRYPTED_PREFIX.length).equals(ENCRYPTED_PREFIX)
  )
}

async function removeStoreFile(): Promise<void> {
  try {
    await unlink(storePath())
  } catch {
    // 文件本来就不存在时忽略
  }
}

async function readStore(): Promise<StoreReadResult> {
  let encrypted: Buffer

  try {
    encrypted = await readFile(storePath())
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return { kind: 'missing' }
    }

    return {
      kind: 'unreadable',
      reason: error instanceof Error ? error.message : '读取凭证文件失败'
    }
  }

  let lastReason = 'safeStorage 不可用'

  for (const wait of DECRYPT_RETRY_DELAYS_MS) {
    if (wait > 0) {
      await delay(wait)
    }

    if (!safeStorage.isEncryptionAvailable()) {
      lastReason = 'safeStorage 不可用'
      continue
    }

    let plaintext: string

    try {
      plaintext = safeStorage.decryptString(encrypted)
    } catch (error) {
      // 密钥初始化竞争或密钥变化：保留文件，等待后续重试
      lastReason = error instanceof Error ? error.message : '解密凭证失败'
      continue
    }

    try {
      const store = parseStore(JSON.parse(plaintext))
      return { kind: 'ok', store: filterTombstoned(store, await readTombstones()) }
    } catch {
      // 解密成功但内容不是合法 JSON：真正的文件损坏，可以安全清理
      return { kind: 'corrupt' }
    }
  }

  // 重试后仍无法解密：密文结构完整时按暂时性失败处理，绝不删除/覆盖原文件；
  // 结构明显不完整（截断、被其他内容覆盖）才判定为损坏
  if (!looksLikeEncryptedStore(encrypted)) {
    return { kind: 'corrupt' }
  }

  return { kind: 'unreadable', reason: lastReason }
}

async function writeStore(store: CredentialStore): Promise<void> {
  const plaintext = JSON.stringify(store)
  const encrypted = safeStorage.encryptString(plaintext)
  const target = storePath()
  const temporary = `${target}.tmp-${process.pid}`

  // 先写临时文件再原子替换，避免进程中断留下半个文件
  await writeFile(temporary, encrypted, { mode: 0o600 })

  try {
    await rename(temporary, target)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      // 忽略清理失败
    }

    throw error
  }
}

function snapshot(store: CredentialStore): CredentialStoreSnapshot {
  return {
    activeUserId: store.activeUserId,
    credentials: store.credentials.map((credential) => ({ ...credential }))
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''

  // 生产页面 app://mychatapp；开发页面只允许本机 Vite
  return url.startsWith('app://mychatapp/') || /^http:\/\/localhost:\d+\//.test(url)
}

async function handleLoad(): Promise<CredentialStoreSnapshot | null> {
  const read = await readStore()

  if (read.kind === 'corrupt') {
    await removeStoreFile()
    return null
  }

  if (read.kind !== 'ok' || read.store.credentials.length === 0) {
    return null
  }

  return snapshot(read.store)
}

async function handleSave(
  _event: IpcMainInvokeEvent,
  input: unknown
): Promise<SaveCredentialResult> {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, reason: 'unavailable' }
  }

  const credential = parseCredential({
    ...(isRecord(input) ? input : {}),
    updatedAt: Date.now()
  })

  if (!credential) {
    return { ok: false, reason: 'invalid' }
  }

  const tombstones = await readTombstones()

  if (
    tombstones.some(
      (entry) =>
        entry.userId === credential.userId && entry.tokenHash === hashToken(credential.refreshToken)
    )
  ) {
    // 已登出的 Token 不允许被重新写回存储
    return { ok: false, reason: 'revoked' }
  }

  const read = await readStore()

  // 暂时无法解密时不能覆盖原文件，否则可能丢掉其他实例刚写入的凭证
  if (read.kind === 'unreadable') {
    console.warn('[auth-storage] 暂时无法读取现有凭证，本次不写入：', read.reason)
    return { ok: false, reason: 'unavailable' }
  }

  if (read.kind === 'corrupt') {
    await removeStoreFile()
  }

  const store = read.kind === 'ok' ? read.store : emptyStore()
  const others = store.credentials.filter((item) => item.userId !== credential.userId)

  // 超出上限时丢弃最久未更新的账号
  while (others.length >= MAX_CREDENTIALS) {
    others.sort((left, right) => left.updatedAt - right.updatedAt)
    others.shift()
  }
  const next: CredentialStore = {
    version: STORE_VERSION,
    activeUserId: credential.userId,
    credentials: [...others, credential]
  }

  await writeStore(next)

  return { ok: true }
}

async function handleClear(_event: IpcMainInvokeEvent, input: unknown): Promise<{ ok: true }> {
  const read = await readStore()

  // 暂时无法解密时保持原文件不动，等密钥恢复后再清理
  if (read.kind === 'unreadable') {
    console.warn('[auth-storage] 暂时无法读取现有凭证，本次不清理：', read.reason)
    return { ok: true }
  }

  if (read.kind === 'corrupt') {
    await removeStoreFile()
    return { ok: true }
  }

  const store = read.kind === 'ok' ? read.store : emptyStore()
  const userId = isRecord(input) ? input.userId : undefined
  const refreshToken = isRecord(input) ? input.refreshToken : undefined
  const targetId = typeof userId === 'string' && /^[1-9]\d*$/.test(userId) ? userId : null
  const targetToken =
    typeof refreshToken === 'string' && refreshToken.length >= 20 ? refreshToken : null

  // 指定 Token 时只删除「账号 + Token」都匹配的条目：
  // 同一账号在其他实例重新登录后，旧实例登出不能删掉新实例刚保存的凭证
  const credentials = targetId
    ? store.credentials.filter((credential) => {
        if (credential.userId !== targetId) {
          return true
        }

        if (targetToken && credential.refreshToken !== targetToken) {
          return true
        }

        return false
      })
    : []

  if (credentials.length === 0) {
    try {
      await unlink(storePath())
    } catch {
      // 文件本来就不存在时忽略
    }
  } else {
    await writeStore({
      version: STORE_VERSION,
      activeUserId:
        store.activeUserId && credentials.some((item) => item.userId === store.activeUserId)
          ? store.activeUserId
          : null,
      credentials
    })
  }

  return { ok: true }
}

function isLockConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

async function removeStaleLock(lockPath: string): Promise<void> {
  const info = await stat(lockPath).catch(() => null)

  if (!info || Date.now() - info.mtimeMs <= TOMBSTONE_LOCK_STALE_MS) {
    return
  }

  // 用 rename 抢占清理权：抢到的一方才能删除，避免误删其他进程刚建的新锁
  const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`

  try {
    await rename(lockPath, stalePath)
    await unlink(stalePath).catch(() => {})
  } catch {
    // 其他进程已清理，忽略
  }
}

// 跨进程互斥：锁文件用 'wx' 独占创建，进程内仍由 writeQueue 串行
async function withTombstoneLock<T>(task: () => Promise<T>): Promise<T> {
  const lockPath = `${tombstonePath()}.lock`
  const deadline = Date.now() + TOMBSTONE_LOCK_TIMEOUT_MS

  for (;;) {
    let handle: FileHandle

    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if (!isLockConflict(error)) {
        throw error
      }

      await removeStaleLock(lockPath)

      if (Date.now() > deadline) {
        // 锁迟迟拿不到时降级为无锁写入：墓碑宁可可能被覆盖，也不要完全丢失
        console.warn('[authStorage] 等待墓碑锁超时，改为无锁写入')
        return task()
      }

      await delay(TOMBSTONE_LOCK_RETRY_MS + Math.random() * TOMBSTONE_LOCK_RETRY_MS)
      continue
    }

    try {
      await handle.writeFile(`${process.pid}:${Date.now()}`)
      return await task()
    } finally {
      await handle.close().catch(() => {})
      await unlink(lockPath).catch(() => {})
    }
  }
}

async function handleAddTombstone(input: unknown): Promise<{ ok: boolean }> {
  const record = isRecord(input) ? input : {}
  const { userId, refreshToken, expiresAt } = record

  if (
    typeof userId !== 'string' ||
    !USER_ID_PATTERN.test(userId) ||
    typeof refreshToken !== 'string' ||
    refreshToken.length < 20 ||
    refreshToken.length > 256
  ) {
    return { ok: false }
  }

  const now = Date.now()
  const requestedExpiry = typeof expiresAt === 'number' ? expiresAt : Number.NaN
  const expiresAtValue = Number.isFinite(requestedExpiry)
    ? Math.min(Math.max(requestedExpiry, now + MIN_TOMBSTONE_AGE_MS), now + MAX_TOMBSTONE_AGE_MS)
    : now + MAX_TOMBSTONE_AGE_MS

  const tokenHash = hashToken(refreshToken)

  // 锁内重新读取并合并，保证多个实例并发追加时不丢条目
  await withTombstoneLock(async () => {
    const entries = (await readTombstones()).filter(
      (entry) => entry.userId !== userId || entry.tokenHash !== tokenHash
    )
    entries.push({ userId, tokenHash, createdAt: now, expiresAt: expiresAtValue })

    await writeTombstones(entries)
  })

  return { ok: true }
}

// 串行化文件写入：双开或并发 IPC 时避免后写覆盖前写导致凭证条目丢失
let writeQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 注册安全存储 IPC；只暴露最小读写接口，不暴露路径或 Node.js API */
export function registerAuthStorage(): void {
  ipcMain.handle('auth-storage:load', (event) => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    return handleLoad()
  })

  ipcMain.handle('auth-storage:save', (event, input: unknown) => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    return enqueue(() => handleSave(event, input))
  })

  ipcMain.handle('auth-storage:clear', (event, input: unknown) => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    return enqueue(() => handleClear(event, input))
  })

  ipcMain.handle('auth-storage:tombstone', (event, input: unknown) => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    return enqueue(() => handleAddTombstone(input))
  })
}
