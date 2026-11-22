import type { CredentialStoreSnapshot, SavedCredential } from '../../../shared/authStorage'

export type { CredentialStoreSnapshot, SavedCredential }

function getAuthStorage(): Window['api']['authStorage'] | null {
  const api = window.api

  if (!api || typeof api !== 'object' || !api.authStorage) {
    return null
  }

  return api.authStorage
}

/** 读取主进程安全存储中的凭证；不可用时返回 null（不影响内存登录） */
export async function loadSavedCredentials(): Promise<CredentialStoreSnapshot | null> {
  const storage = getAuthStorage()

  if (!storage) {
    return null
  }

  try {
    return await storage.load()
  } catch {
    return null
  }
}

/** 覆盖保存某个账号的 Refresh Token；失败时返回原因，不抛出 */
export async function saveCredential(credential: SavedCredential): Promise<string | null> {
  const storage = getAuthStorage()

  if (!storage) {
    return 'unavailable'
  }

  try {
    const result = await storage.save(credential)
    return result.ok ? null : result.reason
  } catch {
    return 'unavailable'
  }
}

/**
 * 删除本地凭证。
 * 传 refreshToken 时只删除该账号下这一个 Token 的条目，避免同一账号双开时
 * 旧实例登出误删新实例刚保存的凭证。
 */
export async function clearCredential(userId?: string, refreshToken?: string): Promise<void> {
  const storage = getAuthStorage()

  if (!storage) {
    return
  }

  try {
    await storage.clear(userId ?? '', refreshToken)
  } catch {
    // 清理失败不阻塞登出流程
  }
}

/**
 * 记录已登出 Token 的墓碑（主进程只保存 SHA-256 哈希）。
 * 本地凭证暂时无法解密时，靠它在之后可读时过滤掉这个 Token。
 */
export async function addCredentialTombstone(
  userId: string,
  refreshToken: string,
  expiresAt?: number
): Promise<boolean> {
  const storage = getAuthStorage()

  if (!storage) {
    return false
  }

  try {
    const result = await storage.addTombstone({ userId, refreshToken, expiresAt })
    return result.ok
  } catch {
    return false
  }
}
