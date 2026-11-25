import { createHash, randomBytes } from 'node:crypto'
import { pool } from '../database/pool'
import { signAccessToken } from './jwt'
import { recordDailyLoginActivity } from './activityService'

/** 勾选自动登录：Refresh Token 30 天滚动有效期 */
export const PERSISTENT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60
/** 未勾选自动登录：临时 Refresh Token 只存在内存中，服务端给 24 小时上限 */
export const TEMPORARY_REFRESH_TTL_SECONDS = 24 * 60 * 60

const REFRESH_TOKEN_BYTES = 32
// 32 字节随机数的 base64url 编码固定为 43 个字符
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export class InvalidRefreshTokenError extends Error {
  constructor() {
    super('登录状态已失效，请重新登录')
    this.name = 'InvalidRefreshTokenError'
  }
}

export type RefreshTokenOwner = {
  id: string
  username: string
  nickname: string
}

export type IssuedRefreshToken = {
  /** 明文 Token，只在响应中返回给客户端，服务端不持久化 */
  refreshToken: string
  /** 过期时间，Unix 毫秒时间戳 */
  refreshExpiresAt: number
  /** 有效期，单位：秒 */
  refreshExpiresIn: number
  isPersistent: boolean
}

export type RefreshRotation = IssuedRefreshToken & {
  accessToken: string
  user: RefreshTokenOwner
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function ttlSeconds(isPersistent: boolean): number {
  return isPersistent ? PERSISTENT_REFRESH_TTL_SECONDS : TEMPORARY_REFRESH_TTL_SECONDS
}

function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')
}

type Queryable = Pick<typeof pool, 'query'>

/**
 * 为指定用户签发新的 Refresh Token。
 * 只把 SHA-256 哈希写入数据库，明文仅返回给调用方。
 */
export async function issueRefreshToken(
  userId: string,
  isPersistent: boolean,
  executor: Queryable = pool
): Promise<IssuedRefreshToken> {
  const token = generateRefreshToken()
  const ttl = ttlSeconds(isPersistent)

  const result = await executor.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, is_persistent, expires_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP + make_interval(secs => $4))
     RETURNING expires_at`,
    [userId, hashRefreshToken(token), isPersistent, ttl]
  )

  return {
    refreshToken: token,
    refreshExpiresAt: new Date(result.rows[0].expires_at).getTime(),
    refreshExpiresIn: ttl,
    isPersistent
  }
}

/** 撤销单个 Refresh Token；Token 不存在或已撤销时返回 false（幂等） */
export async function revokeRefreshToken(token: string): Promise<boolean> {
  if (!REFRESH_TOKEN_PATTERN.test(token)) {
    return false
  }

  const result = await pool.query(
    `UPDATE refresh_tokens
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashRefreshToken(token)]
  )

  return (result.rowCount ?? 0) > 0
}

/** 撤销某用户全部仍有效的 Refresh Token（检测到旧 Token 重放时使用） */
export async function revokeAllRefreshTokens(
  userId: string,
  executor: Queryable = pool
): Promise<void> {
  await executor.query(
    `UPDATE refresh_tokens
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  )
}

type RotationRow = {
  id: string
  user_id: string
  is_persistent: boolean
  expires_at: Date | string
  revoked_at: Date | string | null
  username: string
  nickname: string
  is_deleted: boolean
}

/**
 * 校验并轮换 Refresh Token。
 *
 * - 旧 Token 立即失效，新 Token 从当前时间重新计算有效期（滚动续期）
 * - Token 与用户关联、有效期、撤销状态都在同一个事务里校验
 * - 已撤销的 Token 再次出现视为重放：撤销该用户全部有效 Token
 */
export async function rotateRefreshToken(token: string): Promise<RefreshRotation> {
  if (!REFRESH_TOKEN_PATTERN.test(token)) {
    throw new InvalidRefreshTokenError()
  }

  const tokenHash = hashRefreshToken(token)
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const result = await client.query<RotationRow>(
      `SELECT rt.id, rt.user_id, rt.is_persistent, rt.expires_at, rt.revoked_at,
              u.username, u.nickname, u.is_deleted
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1
       FOR UPDATE OF rt`,
      [tokenHash]
    )

    const row = result.rows[0]

    if (!row) {
      await client.query('ROLLBACK')
      throw new InvalidRefreshTokenError()
    }

    const userId = String(row.user_id)

    if (row.revoked_at !== null) {
      // 旧 Token 被重复使用：视为凭证泄露，撤销该用户所有有效凭证
      await revokeAllRefreshTokens(userId, client)
      await client.query('COMMIT')
      throw new InvalidRefreshTokenError()
    }

    const expired = new Date(row.expires_at).getTime() <= Date.now()

    if (expired || row.is_deleted) {
      await client.query(`UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1`, [
        row.id
      ])
      await client.query('COMMIT')
      throw new InvalidRefreshTokenError()
    }

    const issued = await issueRefreshToken(userId, row.is_persistent, client)

    await client.query(
      `UPDATE refresh_tokens
       SET revoked_at = CURRENT_TIMESTAMP,
           replaced_by_id = (SELECT id FROM refresh_tokens WHERE token_hash = $2)
       WHERE id = $1`,
      [row.id, hashRefreshToken(issued.refreshToken)]
    )

    await client.query('COMMIT')

    // Refresh Token 验证并轮换成功：与密码登录共用每日一次积分限制
    await recordDailyLoginActivity(userId)

    return {
      ...issued,
      accessToken: signAccessToken(userId, String(row.username)),
      user: {
        id: userId,
        username: String(row.username),
        nickname: String(row.nickname)
      }
    }
  } catch (error) {
    if (!(error instanceof InvalidRefreshTokenError)) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // 连接已断开时忽略回滚失败，保留原始错误
      }
    }

    throw error
  } finally {
    client.release()
  }
}
