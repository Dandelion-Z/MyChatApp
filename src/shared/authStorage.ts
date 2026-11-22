/**
 * 自动登录凭证在主进程 / preload / 渲染进程之间共享的类型定义。
 * 这里只有类型，不包含任何运行时代码。
 */

export type SavedCredential = {
  userId: string
  refreshToken: string
  /** Refresh Token 过期时间，Unix 毫秒时间戳 */
  expiresAt: number
}

export type CredentialStoreSnapshot = {
  activeUserId: string | null
  credentials: SavedCredential[]
}

export type SaveCredentialResult = { ok: true } | { ok: false; reason: string }

export type CredentialTombstone = {
  userId: string
  refreshToken: string
  /** Refresh Token 过期时间；墓碑至少保留到该时间（主进程会做上限保护） */
  expiresAt?: number
}

export type AuthStorageApi = {
  load: () => Promise<CredentialStoreSnapshot | null>
  save: (credential: SavedCredential) => Promise<SaveCredentialResult>
  /** 传 refreshToken 时只清除该账号下这个 Token 对应的凭证，避免误删其他实例刚保存的凭证 */
  clear: (userId: string, refreshToken?: string) => Promise<{ ok: true }>
  /** 记录已登出 Token 的墓碑（只存哈希），用于本地凭证暂时不可解密时的兜底 */
  addTombstone: (entry: CredentialTombstone) => Promise<{ ok: boolean }>
}

export type RendererApi = {
  authStorage: AuthStorageApi
}
