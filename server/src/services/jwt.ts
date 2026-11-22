import { sign } from 'jsonwebtoken'

const JWT_SECRET_MIN_BYTES = 32
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60

export class JwtConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JwtConfigError'
  }
}

/**
 * Access Token 有效期。
 * 默认 15 分钟；ACCESS_TOKEN_TTL_SECONDS 仅用于测试环境验证自动刷新，生产保持默认。
 */
function readAccessTokenTtl(): number {
  const raw = process.env.ACCESS_TOKEN_TTL_SECONDS?.trim()

  if (!raw) {
    return DEFAULT_ACCESS_TOKEN_TTL_SECONDS
  }

  const value = Number(raw)

  if (!Number.isInteger(value) || value < 30 || value > 3600) {
    throw new JwtConfigError('ACCESS_TOKEN_TTL_SECONDS 必须是 30～3600 之间的整数')
  }

  return value
}

export const ACCESS_TOKEN_TTL_SECONDS = readAccessTokenTtl()

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET

  if (!secret || !secret.trim()) {
    throw new JwtConfigError('未配置 JWT_SECRET：必须设置至少 32 字节的强随机密钥')
  }

  if (Buffer.byteLength(secret, 'utf8') < JWT_SECRET_MIN_BYTES) {
    throw new JwtConfigError('JWT_SECRET 强度不足：至少需要 32 字节')
  }

  return secret
}

/** 签发短期 Access Token；身份只放在 subject（用户 id）中 */
export function signAccessToken(userId: string, username: string): string {
  return sign({ username }, getJwtSecret(), {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS
  })
}
