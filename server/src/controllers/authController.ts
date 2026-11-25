import type { Request, Response } from 'express'
import {
  DuplicateUsernameError,
  InvalidCredentialsError,
  JwtConfigError,
  loginUser,
  registerUser
} from '../services/authService'
import type { LoginInput, RegisterInput } from '../services/authService'
import { ACCESS_TOKEN_TTL_SECONDS } from '../services/jwt'
import {
  InvalidRefreshTokenError,
  revokeRefreshToken,
  rotateRefreshToken
} from '../services/tokenService'
import { normalizeNickname } from '../utils/text'
import { isValidPasswordFormat } from '../services/passwordPolicy'

const USERNAME_PATTERN = /^[a-z0-9_]+$/

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

function fail<T>(message: string): ValidationResult<T> {
  return { ok: false, message }
}

export function validateRegisterInput(body: unknown): ValidationResult<RegisterInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('请求体必须是 JSON 对象')
  }

  const { username, password, nickname } = body as Record<string, unknown>

  if (typeof username !== 'string') {
    return fail('username 必须是字符串')
  }

  const normalizedUsername = username.trim().toLowerCase()

  if (normalizedUsername.length < 3 || normalizedUsername.length > 20) {
    return fail('username 长度必须为 3～20 个字符')
  }

  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    return fail('username 只能包含英文字母、数字和下划线')
  }

  if (typeof password !== 'string') {
    return fail('password 必须是字符串')
  }

  if (!isValidPasswordFormat(password)) {
    return fail('password 长度必须为 8～128 个字符')
  }

  if (typeof nickname !== 'string') {
    return fail('nickname 必须是字符串')
  }

  const nicknameResult = normalizeNickname(nickname)

  if (!nicknameResult.ok) {
    return fail(nicknameResult.message)
  }

  return {
    ok: true,
    value: {
      username: normalizedUsername,
      password,
      nickname: nicknameResult.value
    }
  }
}

export function validateLoginInput(body: unknown): ValidationResult<LoginInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('请求体必须是 JSON 对象')
  }

  const { username, password, autoLogin } = body as Record<string, unknown>

  if (autoLogin !== undefined && typeof autoLogin !== 'boolean') {
    return fail('autoLogin 必须是布尔值')
  }

  if (typeof username !== 'string') {
    return fail('username 必须是字符串')
  }

  const normalizedUsername = username.trim().toLowerCase()

  if (normalizedUsername.length < 3 || normalizedUsername.length > 20) {
    return fail('username 长度必须为 3～20 个字符')
  }

  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    return fail('username 只能包含英文字母、数字和下划线')
  }

  if (typeof password !== 'string') {
    return fail('password 必须是字符串')
  }

  if (!isValidPasswordFormat(password)) {
    return fail('password 长度必须为 8～128 个字符')
  }

  return {
    ok: true,
    value: {
      username: normalizedUsername,
      password,
      autoLogin: autoLogin === true
    }
  }
}

export async function register(request: Request, response: Response): Promise<void> {
  const validation = validateRegisterInput(request.body)

  if (!validation.ok) {
    response.status(400).json({ success: false, error: validation.message })
    return
  }

  try {
    const user = await registerUser(validation.value)
    response.status(201).json({ success: true, data: user })
  } catch (error) {
    if (error instanceof DuplicateUsernameError) {
      response.status(409).json({ success: false, error: '用户名已被使用' })
      return
    }

    console.error('注册失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

export async function login(request: Request, response: Response): Promise<void> {
  const validation = validateLoginInput(request.body)

  if (!validation.ok) {
    response.status(400).json({ success: false, error: validation.message })
    return
  }

  try {
    const result = await loginUser(validation.value)
    response.status(200).json({ success: true, data: result })
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      response.status(401).json({ success: false, error: '用户名或密码错误' })
      return
    }

    if (error instanceof JwtConfigError) {
      console.error('JWT 配置错误：', error.message)
      response.status(500).json({ success: false, error: '服务器内部错误' })
      return
    }

    console.error('登录失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

async function handleRefresh(request: Request, response: Response): Promise<void> {
  const body: unknown = request.body
  const refreshToken =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).refreshToken
      : undefined

  if (typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
    response.status(400).json({ success: false, error: 'refreshToken 不能为空' })
    return
  }

  try {
    const result = await rotateRefreshToken(refreshToken)
    response.status(200).json({
      success: true,
      data: {
        accessToken: result.accessToken,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: result.refreshToken,
        refreshExpiresIn: result.refreshExpiresIn,
        autoLogin: result.isPersistent,
        user: result.user
      }
    })
  } catch (error) {
    if (error instanceof InvalidRefreshTokenError) {
      response.status(401).json({ success: false, error: '登录状态已失效，请重新登录' })
      return
    }

    if (error instanceof JwtConfigError) {
      console.error('JWT 配置错误：', error.message)
      response.status(500).json({ success: false, error: '服务器内部错误' })
      return
    }

    console.error('刷新登录状态失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

async function handleLogout(request: Request, response: Response): Promise<void> {
  const body: unknown = request.body
  const refreshToken =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).refreshToken
      : undefined

  // 退出接口保持幂等：Token 已失效/不存在也返回成功
  if (typeof refreshToken === 'string' && refreshToken.trim().length > 0) {
    try {
      await revokeRefreshToken(refreshToken)
    } catch (error) {
      // 撤销失败不影响客户端清理本地状态，但不能把 Token 写进日志
      console.error(
        '撤销 Refresh Token 失败：',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  response.status(200).json({ success: true })
}

export { handleLogout as logout, handleRefresh as refresh }
