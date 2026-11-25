import { createHash } from 'node:crypto'
import { argon2id, hash, verify } from 'argon2'
import { pool } from '../database/pool'
import { ACCESS_TOKEN_TTL_SECONDS, JwtConfigError, getJwtSecret, signAccessToken } from './jwt'
import { recordDailyLoginActivity } from './activityService'
import { isValidPasswordFormat } from './passwordPolicy'
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

export class InvalidCurrentPasswordError extends Error {
  constructor() {
    super('原密码错误')
    this.name = 'InvalidCurrentPasswordError'
  }
}

export class InvalidNewPasswordError extends Error {
  constructor() {
    super('新密码长度必须为 8～128 个字符')
    this.name = 'InvalidNewPasswordError'
  }
}

export class PasswordUnchangedError extends Error {
  constructor() {
    super('新密码不能与原密码相同')
    this.name = 'PasswordUnchangedError'
  }
}

export function hashRefreshTokenForComparison(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
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
    // uid 不在 INSERT 列中：由 users_uid_seq 的 nextval() 连续递增分配
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
    // 序列分配不会产生 UID 冲突，唯一冲突只可能来自用户名
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

  // 每日活跃积分：密码认证通过后按 UTC 自然日累加，同日重复登录不重复加分
  await recordDailyLoginActivity(String(row.id))

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

/**
 * 已登录用户修改密码。
 * 只信任认证中间件给出的 userId；先校验原密码，再校验新密码规则与是否与原密码相同。
 * 成功后撤销其他设备的 Refresh Token（当前设备的 token 按哈希保留），
 * 使旧凭证不会继续长期有效，同时避免当前设备被登出。
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentRefreshToken?: string | null
): Promise<void> {
  const result = await pool.query(
    `SELECT password_hash FROM users WHERE id = $1 AND is_deleted = FALSE`,
    [userId]
  )

  const row = result.rows[0]

  if (!row) {
    throw new InvalidCurrentPasswordError()
  }

  let passwordMatches: boolean

  try {
    passwordMatches = await verify(String(row.password_hash), currentPassword)
  } catch {
    passwordMatches = false
  }

  if (!passwordMatches) {
    throw new InvalidCurrentPasswordError()
  }

  if (!isValidPasswordFormat(newPassword)) {
    throw new InvalidNewPasswordError()
  }

  if (newPassword === currentPassword) {
    throw new PasswordUnchangedError()
  }

  const passwordHash = await hash(newPassword, { type: argon2id })
  const keepTokenHash =
    typeof currentRefreshToken === 'string' && currentRefreshToken.length > 0
      ? hashRefreshTokenForComparison(currentRefreshToken)
      : null

  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash])

    if (keepTokenHash) {
      // 除当前设备外的所有有效 Refresh Token 全部撤销
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2`,
        [userId, keepTokenHash]
      )
    } else {
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      )
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
