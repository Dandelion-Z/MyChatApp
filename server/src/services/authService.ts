import { argon2id, hash, verify } from 'argon2'
import { pool } from '../database/pool'
import { ACCESS_TOKEN_TTL_SECONDS, JwtConfigError, getJwtSecret, signAccessToken } from './jwt'
import { issueRefreshToken } from './tokenService'

export { JwtConfigError, getJwtSecret }

export type RegisterInput = {
  username: string
  password: string
  nickname: string
}

export type RegisteredUser = {
  id: string
  username: string
  nickname: string
  createdAt: string
}

export type LoginInput = {
  username: string
  password: string
  /** 勾选自动登录：Refresh Token 持久化保存并使用 30 天滚动有效期 */
  autoLogin: boolean
}

export type LoginUser = {
  id: string
  username: string
  nickname: string
}

export type LoginResult = {
  accessToken: string
  tokenType: 'Bearer'
  expiresIn: number
  refreshToken: string
  refreshExpiresIn: number
  autoLogin: boolean
  user: LoginUser
}

export class DuplicateUsernameError extends Error {
  constructor() {
    super('用户名已存在')
    this.name = 'DuplicateUsernameError'
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('用户名或密码错误')
    this.name = 'InvalidCredentialsError'
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  )
}

export async function registerUser(input: RegisterInput): Promise<RegisteredUser> {
  // 使用 Argon2id 哈希，默认参数：memoryCost 64MB、timeCost 3、parallelism 4
  const passwordHash = await hash(input.password, { type: argon2id })

  try {
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, nickname)
       VALUES ($1, $2, $3)
       RETURNING id, username, nickname, created_at`,
      [input.username, passwordHash, input.nickname]
    )

    const row = result.rows[0]

    return {
      id: String(row.id),
      username: String(row.username),
      nickname: String(row.nickname),
      createdAt: new Date(row.created_at).toISOString()
    }
  } catch (error) {
    // 并发注册由数据库唯一约束兜底：23505 表示用户名冲突
    if (isUniqueViolation(error)) {
      throw new DuplicateUsernameError()
    }

    throw error
  }
}

export async function loginUser(input: LoginInput): Promise<LoginResult> {
  // 参数化查询；软删除用户不允许登录
  const result = await pool.query(
    `SELECT id, username, nickname, password_hash
     FROM users
     WHERE username = $1 AND is_deleted = FALSE`,
    [input.username]
  )

  const row = result.rows[0]

  // 用户不存在与密码错误返回同一个错误，避免泄露用户是否存在
  if (!row) {
    throw new InvalidCredentialsError()
  }

  let passwordMatches: boolean

  try {
    passwordMatches = await verify(String(row.password_hash), input.password)
  } catch {
    // 数据库中的哈希损坏时，也按认证失败处理，不暴露内部细节
    passwordMatches = false
  }

  if (!passwordMatches) {
    throw new InvalidCredentialsError()
  }

  // 调用时校验密钥，缺失或强度不足会抛 JwtConfigError，绝不使用弱密钥签发
  getJwtSecret()

  const userId = String(row.id)
  const username = String(row.username)

  const accessToken = signAccessToken(userId, username)
  const refresh = await issueRefreshToken(userId, input.autoLogin)

  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: refresh.refreshToken,
    refreshExpiresIn: refresh.refreshExpiresIn,
    autoLogin: input.autoLogin,
    user: {
      id: userId,
      username,
      nickname: String(row.nickname)
    }
  }
}
