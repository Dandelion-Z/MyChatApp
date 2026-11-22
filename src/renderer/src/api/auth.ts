import { request } from './client'

export type AuthUser = {
  id: string
  username: string
  nickname: string
}

export type RegisterRequest = {
  username: string
  password: string
  nickname: string
}

export type RegisteredUser = AuthUser & {
  createdAt: string
}

export type RegisterResponse = {
  success: true
  data: RegisteredUser
}

export type LoginRequest = {
  username: string
  password: string
  /** 勾选自动登录：服务端签发 30 天滚动 Refresh Token，客户端加密持久化 */
  autoLogin: boolean
}

export type LoginResult = {
  accessToken: string
  tokenType: 'Bearer'
  /** 有效期，单位：秒 */
  expiresIn: number
  /** 长期凭证明文，仅在客户端内存/安全存储中保存 */
  refreshToken: string
  /** Refresh Token 有效期，单位：秒 */
  refreshExpiresIn: number
  /** 服务端确认该 Refresh Token 是否属于自动登录模式 */
  autoLogin: boolean
  user: AuthUser
}

export type LoginResponse = {
  success: true
  data: LoginResult
}

export type RefreshResponse = {
  success: true
  data: LoginResult
}

export function register(data: RegisterRequest): Promise<RegisterResponse> {
  return request<RegisterResponse>('/api/auth/register', {
    method: 'POST',
    body: data
  })
}

export function login(data: LoginRequest): Promise<LoginResponse> {
  return request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: data
  })
}

/** 刷新并轮换 Refresh Token；旧 Token 在服务端立即失效 */
export function refreshSession(refreshToken: string): Promise<RefreshResponse> {
  return request<RefreshResponse>('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken }
  })
}

/** 撤销当前 Refresh Token（退出登录） */
export function revokeSession(refreshToken: string): Promise<{ success: true }> {
  return request<{ success: true }>('/api/auth/logout', {
    method: 'POST',
    body: { refreshToken }
  })
}
