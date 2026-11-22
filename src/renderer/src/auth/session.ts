import type { AuthUser } from '../api/auth'

const STORAGE_KEY = 'mychatapp.auth'

export type Session = {
  accessToken: string
  user: AuthUser
  /** 过期时间，Unix 毫秒时间戳 */
  expiresAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isValidUser(value: unknown): value is AuthUser {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.username === 'string' &&
    typeof value.nickname === 'string'
  )
}

function isSession(value: unknown): value is Session {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.accessToken === 'string' &&
    value.accessToken.length > 0 &&
    isValidUser(value.user) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
  )
}

/** 读取并校验会话；不存在、格式错误或已过期时返回 null（过期/损坏会顺手清理） */
export function getSession(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)

    if (!raw) {
      return null
    }

    const parsed: unknown = JSON.parse(raw)

    if (!isSession(parsed)) {
      clearSession()
      return null
    }

    if (parsed.expiresAt <= Date.now()) {
      clearSession()
      return null
    }

    return parsed
  } catch {
    clearSession()
    return null
  }
}

export function saveSession(session: Session): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // sessionStorage 不可用时忽略，内存中的认证状态仍然有效
  }
}

export function clearSession(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略清理失败
  }
}
