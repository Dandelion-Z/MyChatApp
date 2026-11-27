import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  DeleteFriendDataRequest,
  DeleteFriendDataResult,
  ListChatPeersResult,
  DeleteLocalChatRequest,
  DeleteLocalChatResult,
  EnsureLocalChatRequest,
  EnsureLocalChatResult,
  ListLocalChatsResult,
  MarkConversationReadRequest,
  MarkConversationReadResult,
  ListLocalMessagesRequest,
  ListLocalMessagesResult,
  LocalChatSummary,
  LocalMessageInput,
  LocalMessageItem,
  LocalMessageStats,
  SaveLocalMessageRequest,
  SaveLocalMessageResult,
  SaveLocalMessagesRequest,
  SaveLocalMessagesResult,
  SetChatFlagsRequest,
  SetChatFlagsResult,
  SetSyncCursorRequest,
  SetSyncCursorResult,
  SyncCursorsResult,
  TouchLocalChatRequest,
  TouchLocalChatResult,
  UnreadSummary
} from '../shared/localMessages'

// 本地聊天记录数据库：所有账号共用一个文件，按 user_id 隔离
const DATA_DIRNAME = 'data'
const DB_FILENAME = 'messages.db'

// 所有账号共享 1 GB 额度；测试时可用环境变量覆盖（单位 MB）
const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024
const QUOTA_ENV = 'POLARNIGHT_LOCAL_STORAGE_QUOTA_MB'

// 超过高水位后按创建时间从旧到新清理，直到回落到低水位
const HIGH_WATER_RATIO = 0.9
const LOW_WATER_RATIO = 0.7
const MIN_CLEANUP_ROWS = 200
// 删除量按需要释放的空间估算后再留一点余量，避免频繁触发清理
const CLEANUP_HEADROOM_RATIO = 1.15
const MAX_CLEANUP_ROUNDS = 5

// 本地 SQLite 结构版本：V1 为整合后的完整初始结构（messages / sync_cursors / chat_entries）。
// 之后的结构变更按 V2、V3……递增，与应用程序版本无关。
// 开发阶段曾把 user_version 用到 6（含已废弃的本地星标实验）；低于等于 LEGACY_SCHEMA_VERSION_MAX
// 的旧库在 open() 中按需补齐列后统一归一到 V1，数据全部保留。
const SCHEMA_VERSION = 1
const LEGACY_SCHEMA_VERSION_MAX = 6

const USER_ID_PATTERN = /^[1-9]\d*$/
const MESSAGE_ID_MAX_LENGTH = 64
const CONTENT_MAX_LENGTH = 2000
const CREATED_AT_MAX_LENGTH = 40
const CREATED_AT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/
const CURSOR_MAX_LENGTH = 256
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/
const DEFAULT_LIST_LIMIT = 30
const MAX_LIST_LIMIT = 100
const MAX_SYNC_MESSAGES_PER_CALL = 200

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_us INTEGER NOT NULL,
  server_id TEXT,
  is_unread INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at_us);
CREATE INDEX IF NOT EXISTS idx_messages_user_created_at ON messages (user_id, created_at_us);
`

// v4 升级：老库补上未读标记列；新库在 CREATE_SCHEMA_SQL 里已包含该列
const ALTER_UNREAD_SQL = `
ALTER TABLE messages ADD COLUMN is_unread INTEGER NOT NULL DEFAULT 0;
`

// 未读索引必须在 is_unread 列确认存在之后再建：老库的 messages 表此时还没有这一列
const CREATE_UNREAD_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (user_id, is_unread);
`

// 增量同步进度：每个账号 + 聊天对象各自一条，只保存服务端返回的不透明游标
const CREATE_SYNC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sync_cursors (
  user_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, peer_id)
);
`

// 聊天列表（会话条目）：只保存会话元数据，最近消息内容与时间仍从 messages 表读取。
// is_pinned / is_muted / is_hidden 是消息列表的管理状态，按账号 + 会话对象隔离；
// is_hidden 用于“删除聊天”：只隐藏入口，历史消息与好友关系都保留。
const CREATE_CHAT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_entries (
  user_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  created_at_us INTEGER NOT NULL,
  last_opened_at_us INTEGER NOT NULL,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_muted INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_entries_user_opened ON chat_entries (user_id, last_opened_at_us);
`

// v6 升级：给已存在的 chat_entries 补上消息列表管理列；只加列，不动历史数据
const ALTER_CHAT_FLAGS_SQL = `
ALTER TABLE chat_entries ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_entries ADD COLUMN is_muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_entries ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
`

// v3 升级：把已有本地消息涉及的聊天对象补成会话条目，保证升级后旧记录能出现在消息列表
const BACKFILL_CHAT_ENTRIES_SQL = `
INSERT OR IGNORE INTO chat_entries (user_id, peer_id, created_at_us, last_opened_at_us)
SELECT
  user_id,
  CASE WHEN sender_id = user_id THEN receiver_id ELSE sender_id END AS peer_id,
  MIN(created_at_us),
  MAX(created_at_us)
FROM messages
GROUP BY user_id, peer_id;
`

/** 写入消息后确保对应会话条目存在：本地已有聊天记录时，升级/首同步也能出现在会话列表里 */
const ENSURE_CHATS_FOR_USER_SQL = `
INSERT OR IGNORE INTO chat_entries (user_id, peer_id, created_at_us, last_opened_at_us)
SELECT
  user_id,
  CASE WHEN sender_id = user_id THEN receiver_id ELSE sender_id END AS peer_id,
  MIN(created_at_us),
  MAX(created_at_us)
FROM messages
WHERE user_id = ?
GROUP BY user_id, peer_id;
`

const INSERT_SQL = `
INSERT INTO messages (
  user_id, message_id, sender_id, receiver_id, content, created_at, created_at_us, server_id,
  is_unread
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, message_id) DO NOTHING
`

let db: DatabaseSync | null = null
let dbFilePath = ''

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_PATTERN.test(value)
}

function parseQuotaBytes(): number {
  const raw = process.env[QUOTA_ENV]?.trim()

  if (!raw) {
    return DEFAULT_QUOTA_BYTES
  }

  const megabytes = Number(raw)

  if (!Number.isInteger(megabytes) || megabytes <= 0) {
    return DEFAULT_QUOTA_BYTES
  }

  return megabytes * 1024 * 1024
}

function databasePath(): string {
  return join(app.getPath('userData'), DATA_DIRNAME, DB_FILENAME)
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 数据库文件 + WAL 的实际占用（SQLite 释放的页只有在 vacuum 之后才还给文件系统） */
function physicalBytes(): number {
  return fileSize(dbFilePath) + fileSize(`${dbFilePath}-wal`) + fileSize(`${dbFilePath}-shm`)
}

/** 数据库逻辑大小（页数 × 页大小），不受 WAL 暂时增长影响，用于容量决策 */
function logicalBytes(connection: DatabaseSync): number {
  const pageCountRow = connection.prepare('PRAGMA page_count').get() as
    { page_count: number } | undefined
  const pageSizeRow = connection.prepare('PRAGMA page_size').get() as
    { page_size: number } | undefined

  return Number(pageCountRow?.page_count ?? 0) * Number(pageSizeRow?.page_size ?? 0)
}

function countRows(connection: DatabaseSync): number {
  const row = connection.prepare('SELECT COUNT(*) AS total FROM messages').get() as
    { total: number } | undefined

  return row ? Number(row.total) : 0
}

/** 把服务端微秒精度时间转成整数微秒，用于排序与按时间清理 */
function toCreatedAtUs(createdAt: string): number | null {
  const match = CREATED_AT_PATTERN.exec(createdAt)

  if (!match) {
    const fallback = Date.parse(createdAt)
    return Number.isFinite(fallback) ? fallback * 1000 : null
  }

  const baseMs = Date.parse(`${match[1]}Z`)

  if (!Number.isFinite(baseMs)) {
    return null
  }

  const fraction = (match[2] ?? '').padEnd(6, '0').slice(0, 6)

  return baseMs * 1000 + Number(fraction)
}

function normalizeMessage(value: unknown): LocalMessageInput | null {
  if (!isRecord(value)) {
    return null
  }

  const { messageId, senderId, receiverId, content, createdAt, serverId } = value

  if (
    typeof messageId !== 'string' ||
    messageId.length === 0 ||
    messageId.length > MESSAGE_ID_MAX_LENGTH ||
    !isUserId(senderId) ||
    !isUserId(receiverId) ||
    typeof content !== 'string' ||
    content.length === 0 ||
    typeof createdAt !== 'string' ||
    createdAt.length === 0 ||
    createdAt.length > CREATED_AT_MAX_LENGTH
  ) {
    return null
  }

  if (content.length > CONTENT_MAX_LENGTH) {
    return null
  }

  if (serverId !== undefined && typeof serverId !== 'string') {
    return null
  }

  return {
    messageId,
    senderId,
    receiverId,
    content,
    createdAt,
    ...(serverId === undefined ? {} : { serverId })
  }
}

function normalizeSaveRequest(value: unknown): SaveLocalMessageRequest | null {
  if (!isRecord(value)) {
    return null
  }

  const { userId, message, markUnread } = value

  if (!isUserId(userId)) {
    return null
  }

  const normalized = normalizeMessage(message)

  return normalized
    ? { userId, message: normalized, ...(markUnread === true ? { markUnread: true } : {}) }
    : null
}

function normalizeSaveManyRequest(value: unknown): SaveLocalMessagesRequest | null {
  if (!isRecord(value)) {
    return null
  }

  const { userId, messages, markUnread } = value

  if (!isUserId(userId) || !Array.isArray(messages)) {
    return null
  }

  if (messages.length > MAX_SYNC_MESSAGES_PER_CALL) {
    return null
  }

  const normalized: LocalMessageInput[] = []

  for (const message of messages) {
    const item = normalizeMessage(message)

    if (!item) {
      return null
    }

    normalized.push(item)
  }

  return {
    userId,
    messages: normalized,
    ...(markUnread === true ? { markUnread: true } : {})
  }
}

function parseListLimit(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_LIST_LIMIT
  }

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LIST_LIMIT
  ) {
    return null
  }

  return value
}

function isCursor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CURSOR_MAX_LENGTH &&
    CURSOR_PATTERN.test(value)
  )
}

function normalizeListRequest(value: unknown): ListLocalMessagesRequest | null {
  if (!isRecord(value)) {
    return null
  }

  const { userId, peerId, limit, before } = value

  // 允许 userId === peerId：自我聊天同样需要读取本地历史
  if (!isUserId(userId) || !isUserId(peerId)) {
    return null
  }

  const normalizedLimit = parseListLimit(limit)

  if (normalizedLimit === null) {
    return null
  }

  if (before !== undefined && !isCursor(before)) {
    return null
  }

  return {
    userId,
    peerId,
    limit: normalizedLimit,
    ...(before === undefined ? {} : { before })
  }
}

type LocalCursor = { us: number; mid: string }

function encodeLocalCursor(createdAtUs: number, messageId: string): string {
  return Buffer.from(JSON.stringify({ u: createdAtUs, m: messageId }), 'utf8').toString('base64url')
}

function decodeLocalCursor(raw: string): LocalCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))

    if (!isRecord(decoded)) {
      return null
    }

    const { u, m } = decoded

    if (typeof u !== 'number' || !Number.isSafeInteger(u) || u < 0) {
      return null
    }

    if (typeof m !== 'string' || m.length === 0 || m.length > MESSAGE_ID_MAX_LENGTH) {
      return null
    }

    return { us: u, mid: m }
  } catch {
    return null
  }
}

function toMessageItem(row: Record<string, unknown>): LocalMessageItem {
  const serverId = row.server_id

  return {
    messageId: String(row.message_id),
    senderId: String(row.sender_id),
    receiverId: String(row.receiver_id),
    content: String(row.content),
    createdAt: String(row.created_at),
    ...(serverId === null || serverId === undefined ? {} : { serverId: String(serverId) })
  }
}

function open(): DatabaseSync {
  if (db) {
    return db
  }

  const filePath = databasePath()
  dbFilePath = filePath
  const isNew = !existsSync(filePath)

  mkdirSync(join(app.getPath('userData'), DATA_DIRNAME), { recursive: true })

  const connection = new DatabaseSync(filePath)

  // WAL 提高并发写入与崩溃恢复能力；NORMAL 在 WAL 下仍然安全且更快
  connection.exec('PRAGMA journal_mode = WAL')
  connection.exec('PRAGMA synchronous = NORMAL')
  connection.exec('PRAGMA busy_timeout = 5000')
  // 限制 WAL 增长（约 1 MB 自动 checkpoint），避免 WAL 长期占用额外空间
  connection.exec('PRAGMA wal_autocheckpoint = 256')
  // auto_vacuum 只能在建表前或 VACUUM 时生效；新库直接开启，旧库保持兼容
  connection.exec('PRAGMA auto_vacuum = INCREMENTAL')

  if (isNew) {
    connection.exec('VACUUM')
  }

  connection.exec(CREATE_SCHEMA_SQL)
  connection.exec(CREATE_SYNC_SCHEMA_SQL)
  connection.exec(CREATE_CHAT_SCHEMA_SQL)

  const versionRow = connection.prepare('PRAGMA user_version').get() as
    { user_version: number } | undefined
  const version = versionRow ? Number(versionRow.user_version) : 0

  if (version < 3) {
    // v3：从已有消息回填会话条目；已有条目保持用户自己的最近打开时间
    connection.exec(BACKFILL_CHAT_ENTRIES_SQL)
  }

  const messageColumns = connection.prepare('PRAGMA table_info(messages)').all() as Array<
    Record<string, unknown>
  >
  const hasUnreadColumn = messageColumns.some((column) => column.name === 'is_unread')

  if (!hasUnreadColumn) {
    // v4：未读标记直接落在消息行上，天然跟随 messageId 去重，不额外维护计数表
    connection.exec(ALTER_UNREAD_SQL)
  }

  // 索引与列无关地统一补建：新库在 CREATE_SCHEMA_SQL 后已具备列，老库则刚刚完成 ALTER
  connection.exec(CREATE_UNREAD_INDEX_SQL)

  const chatColumns = connection.prepare('PRAGMA table_info(chat_entries)').all() as Array<
    Record<string, unknown>
  >
  const hasChatFlags = chatColumns.some((column) => column.name === 'is_pinned')

  if (!hasChatFlags) {
    // v6：旧库补上置顶 / 免打扰 / 隐藏列，历史会话与未读记录原样保留
    connection.exec(ALTER_CHAT_FLAGS_SQL)
  }

  if (version !== SCHEMA_VERSION && version <= LEGACY_SCHEMA_VERSION_MAX) {
    // 空库（0）与开发阶段旧版本号（2~6）统一归一到 V1；结构已在上方按需补齐，历史数据保留。
    // 未来新增 V2 时，在这里按 version 分支执行对应迁移，再写入新版本号。
    connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  db = connection

  return connection
}

/** 空间不足时按创建时间从旧到新删除，不区分账号与聊天对象 */
function cleanupIfNeeded(connection: DatabaseSync): void {
  const quota = parseQuotaBytes()
  const highWater = quota * HIGH_WATER_RATIO
  const lowWater = quota * LOW_WATER_RATIO
  let size = logicalBytes(connection)

  if (size <= highWater) {
    return
  }

  for (let round = 0; round < MAX_CLEANUP_ROUNDS && size > highWater; round += 1) {
    const total = countRows(connection)

    if (total === 0) {
      return
    }

    // 按当前平均行占用估算需要删除多少条才能回到低水位，再留 15% 余量
    const averageRowBytes = Math.max(1, size / total)
    const bytesToFree = Math.max(size - lowWater, averageRowBytes * MIN_CLEANUP_ROWS)
    const toDelete = Math.min(
      total,
      Math.max(
        MIN_CLEANUP_ROWS,
        Math.ceil((bytesToFree / averageRowBytes) * CLEANUP_HEADROOM_RATIO)
      )
    )

    // 不区分账号与聊天对象，只按消息创建时间从旧到新删除
    connection.exec(
      `DELETE FROM messages WHERE rowid IN (
         SELECT rowid FROM messages ORDER BY created_at_us ASC, rowid ASC LIMIT ${toDelete}
       )`
    )
    // 立即把删除后空闲的页还给文件系统，避免数据库文件长期占用已释放的空间
    connection.exec('PRAGMA incremental_vacuum')
    connection.exec('PRAGMA wal_checkpoint(TRUNCATE)')

    size = logicalBytes(connection)
  }

  if (size > highWater) {
    console.warn('[localMessages] 清理后仍高于高水位，继续保留最新消息')
  }
}

function saveMessage(request: SaveLocalMessageRequest): SaveLocalMessageResult {
  const result = saveMessages({
    userId: request.userId,
    messages: [request.message],
    ...(request.markUnread === true ? { markUnread: true } : {})
  })

  return result.ok ? { ok: true, inserted: result.inserted > 0 } : result
}

/**
 * 批量写入（增量同步按页落地）。
 *
 * 1. 先校验整页消息，任何一条不合法都整页拒绝，避免半页数据造成游标与数据不一致；
 * 2. 事务内逐条 INSERT ... ON CONFLICT DO NOTHING，重复 messageId 不会产生重复记录；
 * 3. 提交成功后统一做容量清理。
 */
function saveMessages(request: SaveLocalMessagesRequest): SaveLocalMessagesResult {
  const connection = open()
  const createdAtsUs: number[] = []

  for (const message of request.messages) {
    const createdAtUs = toCreatedAtUs(message.createdAt)

    if (createdAtUs === null) {
      return { ok: false, reason: 'invalid createdAt' }
    }

    createdAtsUs.push(createdAtUs)
  }

  const statement = connection.prepare(INSERT_SQL)
  const lastOpenedStatement = connection.prepare(
    'SELECT last_opened_at_us FROM chat_entries WHERE user_id = ? AND peer_id = ?'
  )
  const lastOpenedCache = new Map<string, number>()
  const lastOpenedAt = (peerId: string): number => {
    const cached = lastOpenedCache.get(peerId)

    if (cached !== undefined) {
      return cached
    }

    const row = lastOpenedStatement.get(request.userId, peerId) as
      { last_opened_at_us?: unknown } | undefined
    const value = row ? Number(row.last_opened_at_us) : 0
    const normalized = Number.isFinite(value) ? value : 0

    lastOpenedCache.set(peerId, normalized)

    return normalized
  }
  let inserted = 0
  // 有新消息的会话即使之前被“删除聊天”隐藏，也应重新出现在消息列表里
  const insertedPeers = new Set<string>()

  connection.exec('BEGIN')

  try {
    for (let index = 0; index < request.messages.length; index += 1) {
      const message = request.messages[index]
      // 只有“别人发给我”的消息才可能未读；自己的消息永远不会计入未读。
      // 另外，早于该会话最近一次打开时间的消息视为已读过的历史（例如先看过服务端分页、后台同步才补写本地）。
      const peerId = message.senderId === request.userId ? message.receiverId : message.senderId
      const unread =
        request.markUnread &&
        message.senderId !== request.userId &&
        createdAtsUs[index] > lastOpenedAt(peerId)
          ? 1
          : 0
      const result = statement.run(
        request.userId,
        message.messageId,
        message.senderId,
        message.receiverId,
        message.content,
        message.createdAt,
        createdAtsUs[index],
        message.serverId ?? null,
        unread
      )

      if (Number(result.changes) > 0) {
        inserted += 1
        insertedPeers.add(peerId)
      }
    }

    connection.exec('COMMIT')
  } catch (error) {
    try {
      connection.exec('ROLLBACK')
    } catch {
      // 回滚失败时保留原始错误
    }

    throw error
  }

  // 有新消息的会话立即出现在会话列表里；已存在的条目不会被改写
  if (inserted > 0) {
    connection.prepare(ENSURE_CHATS_FOR_USER_SQL).run(request.userId)
    const unhide = connection.prepare(
      'UPDATE chat_entries SET is_hidden = 0 WHERE user_id = ? AND peer_id = ?'
    )

    for (const peerId of insertedPeers) {
      unhide.run(request.userId, peerId)
    }
  }

  // 落盘后立即做容量检查，保证新消息写入成功后旧数据不会把额度撑爆
  cleanupIfNeeded(connection)

  return { ok: true, inserted, received: request.messages.length }
}

/**
 * 按账号 + 聊天对象读取本地历史。
 *
 * 账号隔离完全由 user_id 条件保证：即使传入其他账号的 ID，也只会命中该账号自己的记录；
 * 聊天双方必须正好是 userId 与 peerId。
 */
function listMessages(request: ListLocalMessagesRequest): ListLocalMessagesResult {
  const connection = open()
  const limit = request.limit ?? DEFAULT_LIST_LIMIT
  const cursor = request.before ? decodeLocalCursor(request.before) : null

  const values: Array<string | number> = [
    request.userId,
    request.userId,
    request.peerId,
    request.peerId,
    request.userId
  ]
  let cursorClause = ''

  if (cursor) {
    values.push(cursor.us, cursor.us, cursor.mid)
    cursorClause = 'AND (created_at_us < ? OR (created_at_us = ? AND message_id < ?))'
  }

  values.push(limit + 1)

  const rows = connection
    .prepare(
      `SELECT message_id, sender_id, receiver_id, content, created_at, created_at_us, server_id
       FROM messages
       WHERE user_id = ?
         AND (
               (sender_id = ? AND receiver_id = ?)
            OR (sender_id = ? AND receiver_id = ?)
             )
         ${cursorClause}
       ORDER BY created_at_us DESC, message_id DESC
       LIMIT ?`
    )
    .all(...values) as Array<Record<string, unknown>>

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const oldestRow = pageRows[pageRows.length - 1]
  const nextCursor =
    hasMore && oldestRow
      ? encodeLocalCursor(Number(oldestRow.created_at_us), String(oldestRow.message_id))
      : null

  // 查询按时间倒序取页，返回前反转为升序，便于按时间顺序展示
  const messages = [...pageRows].reverse().map(toMessageItem)

  return { messages, hasMore, nextCursor }
}

function getSyncCursors(userId: string): SyncCursorsResult {
  const connection = open()
  const rows = connection
    .prepare('SELECT peer_id, cursor FROM sync_cursors WHERE user_id = ?')
    .all(userId) as Array<Record<string, unknown>>
  const cursors: Record<string, string> = {}

  for (const row of rows) {
    cursors[String(row.peer_id)] = String(row.cursor)
  }

  return { cursors }
}

function setSyncCursor(request: SetSyncCursorRequest): SetSyncCursorResult {
  const connection = open()

  connection
    .prepare(
      `INSERT INTO sync_cursors (user_id, peer_id, cursor, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, peer_id)
       DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`
    )
    .run(request.userId, request.peerId, request.cursor, Date.now())

  return { ok: true }
}

function normalizeSetCursorRequest(value: unknown): SetSyncCursorRequest | null {
  if (!isRecord(value)) {
    return null
  }

  const { userId, peerId, cursor } = value

  // 允许 peerId === userId：自我聊天同样需要保存增量同步游标
  if (!isUserId(userId) || !isUserId(peerId) || !isCursor(cursor)) {
    return null
  }

  return { userId, peerId, cursor }
}

/** 当前时间的微秒表示，用于会话条目的排序字段 */
function nowUs(): number {
  return Date.now() * 1000
}

/**
 * 读取某个账号的聊天列表。
 * 最近一条消息的内容与时间直接从 messages 表读取，不在会话表里重复存储。
 */
function listChats(userId: string): ListLocalChatsResult {
  const connection = open()
  const rows = connection
    .prepare(
      `SELECT
         e.peer_id,
         e.created_at_us,
         e.last_opened_at_us,
         e.is_pinned,
         e.is_muted,
         last.content AS last_content,
         last.created_at_us AS last_at_us,
         COALESCE(unread.total, 0) AS unread_count
       FROM chat_entries e
       LEFT JOIN (
         SELECT
           m.user_id,
           CASE WHEN m.sender_id = m.user_id THEN m.receiver_id ELSE m.sender_id END AS peer_id,
           COUNT(*) AS total
         FROM messages m
         WHERE m.user_id = ? AND m.is_unread = 1
         GROUP BY m.user_id,
           CASE WHEN m.sender_id = m.user_id THEN m.receiver_id ELSE m.sender_id END
       ) unread
         ON unread.user_id = e.user_id AND unread.peer_id = e.peer_id
       LEFT JOIN (
         SELECT
           m.user_id,
           CASE WHEN m.sender_id = m.user_id THEN m.receiver_id ELSE m.sender_id END AS peer_id,
           m.content,
           m.created_at_us,
           ROW_NUMBER() OVER (
             PARTITION BY m.user_id,
               CASE WHEN m.sender_id = m.user_id THEN m.receiver_id ELSE m.sender_id END
             ORDER BY m.created_at_us DESC, m.rowid DESC
           ) AS rn
         FROM messages m
         WHERE m.user_id = ?
       ) last
         ON last.user_id = e.user_id AND last.peer_id = e.peer_id AND last.rn = 1
       WHERE e.user_id = ?
         AND e.is_hidden = 0
       ORDER BY
         e.is_pinned DESC,
         CASE WHEN last.created_at_us IS NULL THEN 1 ELSE 0 END,
         CASE
           WHEN last.created_at_us IS NULL THEN e.last_opened_at_us
           ELSE last.created_at_us
         END DESC`
    )
    .all(userId, userId, userId) as Array<Record<string, unknown>>

  const chats: LocalChatSummary[] = rows.map((row) => {
    const lastContent = row.last_content
    const lastAtUs = row.last_at_us

    return {
      peerId: String(row.peer_id),
      createdAtUs: Number(row.created_at_us),
      lastOpenedAtUs: Number(row.last_opened_at_us),
      lastMessageContent:
        lastContent === null || lastContent === undefined ? null : String(lastContent),
      lastMessageAtUs: lastAtUs === null || lastAtUs === undefined ? null : Number(lastAtUs),
      unreadCount: Number(row.unread_count ?? 0),
      isPinned: Number(row.is_pinned) === 1,
      isMuted: Number(row.is_muted) === 1
    }
  })

  return { chats }
}

function ensureChat(userId: string, peerId: string, atUs: number = nowUs()): EnsureLocalChatResult {
  const connection = open()
  // ON CONFLICT 保证重复调用只会在首次真正创建条目
  const result = connection
    .prepare(
      `INSERT INTO chat_entries (user_id, peer_id, created_at_us, last_opened_at_us)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, peer_id) DO NOTHING`
    )
    .run(userId, peerId, atUs, atUs)

  // 重新打开会话即恢复被“删除聊天”隐藏的入口；只改隐藏位，不重建条目
  connection
    .prepare('UPDATE chat_entries SET is_hidden = 0 WHERE user_id = ? AND peer_id = ?')
    .run(userId, peerId)

  return { ok: true, created: Number(result.changes) > 0 }
}

function touchChat(userId: string, peerId: string, atUs: number = nowUs()): TouchLocalChatResult {
  ensureChat(userId, peerId, atUs)
  open()
    .prepare(
      `UPDATE chat_entries
       SET last_opened_at_us = ?, is_hidden = 0
       WHERE user_id = ? AND peer_id = ?`
    )
    .run(atUs, userId, peerId)

  return { ok: true }
}

/**
 * 把某个会话收到的未读消息全部标为已读。
 * 只影响 userId 与 peerId 之间这一条会话，其他会话不受影响；重复调用是幂等的。
 */
function markConversationRead(request: MarkConversationReadRequest): MarkConversationReadResult {
  const connection = open()
  const result = connection
    .prepare(
      `UPDATE messages
       SET is_unread = 0
       WHERE user_id = ?
         AND is_unread = 1
         AND (
              (sender_id = ? AND receiver_id = ?)
           OR (sender_id = ? AND receiver_id = ?)
             )`
    )
    .run(request.userId, request.userId, request.peerId, request.peerId, request.userId)

  return { ok: true, cleared: Number(result.changes) }
}

/**
 * 消息列表管理：置顶 / 免打扰。
 * 只改会话条目的展示状态，不触碰消息与未读记录。
 */
function setChatFlags(request: SetChatFlagsRequest): SetChatFlagsResult {
  const connection = open()

  ensureChat(request.userId, request.peerId)

  const assignments: string[] = []
  const values: Array<string | number> = []

  if (request.pinned !== undefined) {
    assignments.push('is_pinned = ?')
    values.push(request.pinned ? 1 : 0)
  }

  if (request.muted !== undefined) {
    assignments.push('is_muted = ?')
    values.push(request.muted ? 1 : 0)
  }

  if (assignments.length === 0) {
    return { ok: false }
  }

  values.push(request.userId, request.peerId)

  const result = connection
    .prepare(`UPDATE chat_entries SET ${assignments.join(', ')} WHERE user_id = ? AND peer_id = ?`)
    .run(...values)

  return { ok: Number(result.changes) > 0 }
}

/**
 * 删除聊天：只把会话入口标记为隐藏，历史消息、未读标记以外的数据与好友关系都保留。
 *
 * 不能直接 DELETE chat_entries：本地会话回填、消息同步都会按历史消息重建条目，
 * 隐藏位才能保证重启后已删除的聊天不会自己回来。同时清除该会话未读，使导航角标同步。
 */
function deleteChat(request: DeleteLocalChatRequest): DeleteLocalChatResult {
  const connection = open()

  ensureChat(request.userId, request.peerId)

  const hidden = connection
    .prepare('UPDATE chat_entries SET is_hidden = 1 WHERE user_id = ? AND peer_id = ?')
    .run(request.userId, request.peerId)

  const cleared = connection
    .prepare(
      `UPDATE messages
       SET is_unread = 0
       WHERE user_id = ?
         AND is_unread = 1
         AND (
              (sender_id = ? AND receiver_id = ?)
           OR (sender_id = ? AND receiver_id = ?)
             )`
    )
    .run(request.userId, request.userId, request.peerId, request.peerId, request.userId)

  return { ok: Number(hidden.changes) > 0, clearedUnread: Number(cleared.changes) }
}

/**
 * 删除好友后的本地清理：删除与该好友的全部本地消息、会话条目与同步游标，并清除未读。
 *
 * 只影响当前账号与指定好友；调用前必须已确认服务端删除成功。
 * 与“删除聊天”不同，这里会真正删除本地历史，重新添加好友后不再显示旧记录。
 */
function deleteFriendData(request: DeleteFriendDataRequest): DeleteFriendDataResult {
  const connection = open()
  const pairCondition = `((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))`
  const pairValues = [request.userId, request.peerId, request.peerId, request.userId]

  connection.exec('BEGIN')

  try {
    const unreadRow = connection
      .prepare(
        `SELECT COUNT(*) AS total FROM messages WHERE user_id = ? AND is_unread = 1 AND ${pairCondition}`
      )
      .get(request.userId, ...pairValues) as Record<string, unknown>

    const deleted = connection
      .prepare(`DELETE FROM messages WHERE user_id = ? AND ${pairCondition}`)
      .run(request.userId, ...pairValues)

    connection
      .prepare('DELETE FROM chat_entries WHERE user_id = ? AND peer_id = ?')
      .run(request.userId, request.peerId)

    connection
      .prepare('DELETE FROM sync_cursors WHERE user_id = ? AND peer_id = ?')
      .run(request.userId, request.peerId)

    connection.exec('COMMIT')

    return {
      ok: true,
      deletedMessages: Number(deleted.changes),
      clearedUnread: Number(unreadRow.total)
    }
  } catch (error) {
    try {
      connection.exec('ROLLBACK')
    } catch {
      // 回滚失败时保留原始错误
    }

    throw error
  }
}

/**
 * 列出本地库中该账号涉及的全部聊天对象（消息、会话条目、同步游标三处的并集）。
 * 用于好友列表刷新后与服务端好友集合做差集，避免只检查当前界面显示的会话。
 */
function listChatPeers(userId: string): ListChatPeersResult {
  const connection = open()
  const rows = connection
    .prepare(
      `SELECT peer_id FROM (
         SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS peer_id
           FROM messages
          WHERE user_id = ? AND (sender_id = ? OR receiver_id = ?)
         UNION
         SELECT peer_id FROM chat_entries WHERE user_id = ?
         UNION
         SELECT peer_id FROM sync_cursors WHERE user_id = ?
       )
       ORDER BY peer_id`
    )
    .all(userId, userId, userId, userId, userId, userId) as Array<Record<string, unknown>>

  return { peers: rows.map((row) => String(row.peer_id)) }
}

/** 读取未读统计：总数与按会话拆分；未读标记直接来自消息行，重启后仍然准确 */
function getUnreadSummary(userId: string): UnreadSummary {
  const connection = open()
  const rows = connection
    .prepare(
      `SELECT
         CASE WHEN sender_id = user_id THEN receiver_id ELSE sender_id END AS peer_id,
         COUNT(*) AS total
       FROM messages
       WHERE user_id = ? AND is_unread = 1
       GROUP BY peer_id`
    )
    .all(userId) as Array<Record<string, unknown>>

  const byPeer: Record<string, number> = {}
  let total = 0

  for (const row of rows) {
    const count = Number(row.total)

    if (count > 0) {
      byPeer[String(row.peer_id)] = count
      total += count
    }
  }

  return { total, byPeer }
}

function normalizeChatRequest(value: unknown): { userId: string; peerId: string } | null {
  if (!isRecord(value)) {
    return null
  }

  const { userId, peerId } = value

  // 自我聊天的 peerId 就是当前账号本身，因此这里允许 userId === peerId
  if (!isUserId(userId) || !isUserId(peerId)) {
    return null
  }

  return { userId, peerId }
}

function normalizeSetChatFlagsRequest(value: unknown): SetChatFlagsRequest | null {
  const base = normalizeChatRequest(value)

  if (!base) {
    return null
  }

  const record = value as Record<string, unknown>
  const pinned = record.pinned
  const muted = record.muted

  if (pinned !== undefined && typeof pinned !== 'boolean') {
    return null
  }

  if (muted !== undefined && typeof muted !== 'boolean') {
    return null
  }

  if (pinned === undefined && muted === undefined) {
    return null
  }

  return {
    ...base,
    ...(pinned === undefined ? {} : { pinned }),
    ...(muted === undefined ? {} : { muted })
  }
}

function normalizeTouchChatRequest(value: unknown): TouchLocalChatRequest | null {
  const base = normalizeChatRequest(value)

  if (!base) {
    return null
  }

  const atUs = (value as Record<string, unknown>).atUs

  if (atUs === undefined) {
    return base
  }

  if (typeof atUs !== 'number' || !Number.isSafeInteger(atUs) || atUs <= 0) {
    return null
  }

  return { ...base, atUs }
}

function getStats(): LocalMessageStats {
  const quotaBytes = parseQuotaBytes()

  if (!db) {
    return { count: 0, bytes: dbFilePath ? physicalBytes() : 0, quotaBytes }
  }

  return {
    count: countRows(db),
    bytes: physicalBytes(),
    quotaBytes
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''

  // 生产页面 app://mychatapp；开发页面只允许本机 Vite
  return url.startsWith('app://mychatapp/') || /^http:\/\/localhost:\d+\//.test(url)
}

function closeLocalMessageStore(): void {
  if (!db) {
    return
  }

  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (error) {
    console.warn('[localMessages] 关闭前 checkpoint 失败', error)
  }

  try {
    db.close()
  } catch (error) {
    console.warn('[localMessages] 关闭数据库失败', error)
  }

  db = null
}

export function registerLocalMessageStore(): void {
  dbFilePath = databasePath()

  // 启动时打开并校验数据库：既保证旧数据在升级后可继续使用，也让容量统计从一开始就准确
  try {
    open()
  } catch (error) {
    console.error('[localMessages] 打开本地数据库失败', error)
  }

  ipcMain.handle('local-messages:save', (event, input: unknown): SaveLocalMessageResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    const request = normalizeSaveRequest(input)

    if (!request) {
      return { ok: false, reason: 'invalid payload' }
    }

    try {
      return saveMessage(request)
    } catch (error) {
      console.error('[localMessages] 保存消息失败', error)
      return { ok: false, reason: 'storage error' }
    }
  })

  ipcMain.handle('local-messages:stats', (event): LocalMessageStats => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    return getStats()
  })

  ipcMain.handle('local-messages:save-many', (event, input: unknown): SaveLocalMessagesResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    const request = normalizeSaveManyRequest(input)

    if (!request) {
      return { ok: false, reason: 'invalid payload' }
    }

    try {
      return saveMessages(request)
    } catch (error) {
      console.error('[localMessages] 批量保存消息失败', error)
      return { ok: false, reason: 'storage error' }
    }
  })

  ipcMain.handle('local-messages:list', (event, input: unknown): ListLocalMessagesResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    const request = normalizeListRequest(input)

    if (!request) {
      return { messages: [], hasMore: false, nextCursor: null }
    }

    return listMessages(request)
  })

  ipcMain.handle('local-messages:sync-cursors', (event, userId: unknown): SyncCursorsResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    if (!isUserId(userId)) {
      return { cursors: {} }
    }

    return getSyncCursors(userId)
  })

  ipcMain.handle('local-messages:set-sync-cursor', (event, input: unknown): SetSyncCursorResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    const request = normalizeSetCursorRequest(input)

    if (!request) {
      return { ok: false }
    }

    try {
      return setSyncCursor(request)
    } catch (error) {
      console.error('[localMessages] 保存同步游标失败', error)
      return { ok: false }
    }
  })

  ipcMain.handle('local-messages:list-chats', (event, userId: unknown): ListLocalChatsResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    if (!isUserId(userId)) {
      return { chats: [] }
    }

    try {
      return listChats(userId)
    } catch (error) {
      console.error('[localMessages] 读取聊天列表失败', error)
      return { chats: [] }
    }
  })

  ipcMain.handle('local-messages:ensure-chat', (event, input: unknown): EnsureLocalChatResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    const request: EnsureLocalChatRequest | null = normalizeChatRequest(input)

    if (!request) {
      return { ok: true, created: false }
    }

    try {
      return ensureChat(request.userId, request.peerId)
    } catch (error) {
      console.error('[localMessages] 创建聊天条目失败', error)
      return { ok: true, created: false }
    }
  })

  ipcMain.handle('local-messages:touch-chat', (event, input: unknown): TouchLocalChatResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    const request = normalizeTouchChatRequest(input)

    if (!request) {
      return { ok: true }
    }

    try {
      return touchChat(request.userId, request.peerId, request.atUs)
    } catch (error) {
      console.error('[localMessages] 更新聊天打开时间失败', error)
      return { ok: true }
    }
  })

  ipcMain.handle('local-messages:unread-summary', (event, userId: unknown): UnreadSummary => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    if (!isUserId(userId)) {
      return { total: 0, byPeer: {} }
    }

    try {
      return getUnreadSummary(userId)
    } catch (error) {
      console.error('[localMessages] 读取未读统计失败', error)
      return { total: 0, byPeer: {} }
    }
  })

  ipcMain.handle(
    'local-messages:mark-read',
    (event, input: unknown): MarkConversationReadResult => {
      if (!isTrustedSender(event)) {
        throw new Error('unauthorized sender')
      }

      const request = normalizeChatRequest(input)

      if (!request) {
        return { ok: true, cleared: 0 }
      }

      try {
        return markConversationRead(request)
      } catch (error) {
        console.error('[localMessages] 标记会话已读失败', error)
        return { ok: true, cleared: 0 }
      }
    }
  )

  ipcMain.handle('local-messages:set-chat-flags', (event, input: unknown): SetChatFlagsResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    const request = normalizeSetChatFlagsRequest(input)

    if (!request) {
      return { ok: false }
    }

    try {
      return setChatFlags(request)
    } catch (error) {
      console.error('[localMessages] 更新会话管理状态失败', error)
      return { ok: false }
    }
  })

  ipcMain.handle('local-messages:delete-chat', (event, input: unknown): DeleteLocalChatResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    const request = normalizeChatRequest(input)

    if (!request) {
      return { ok: false, clearedUnread: 0 }
    }

    try {
      return deleteChat(request)
    } catch (error) {
      console.error('[localMessages] 删除聊天失败', error)
      return { ok: false, clearedUnread: 0 }
    }
  })

  ipcMain.handle(
    'local-messages:delete-friend-data',
    (event, input: unknown): DeleteFriendDataResult => {
      if (!isTrustedSender(event)) {
        throw new Error('unauthorized sender')
      }

      const request = normalizeChatRequest(input)

      // 自我聊天不能通过删除好友清理
      if (!request || request.userId === request.peerId) {
        return { ok: false, deletedMessages: 0, clearedUnread: 0 }
      }

      try {
        return deleteFriendData(request)
      } catch (error) {
        console.error('[localMessages] 清理好友本地数据失败', error)
        return { ok: false, deletedMessages: 0, clearedUnread: 0 }
      }
    }
  )

  ipcMain.handle('local-messages:chat-peers', (event, userId: unknown): ListChatPeersResult => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    if (!isUserId(userId)) {
      return { peers: [] }
    }

    try {
      return listChatPeers(userId)
    } catch (error) {
      console.error('[localMessages] 读取本地聊天对象失败', error)
      return { peers: [] }
    }
  })

  app.on('will-quit', () => {
    closeLocalMessageStore()
  })
}
