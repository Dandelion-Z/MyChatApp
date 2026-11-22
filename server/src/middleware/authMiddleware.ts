import type { NextFunction, Request, Response } from 'express'
import { verify } from 'jsonwebtoken'
import { getJwtSecret, JwtConfigError } from '../services/authService'

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i
const USER_ID_PATTERN = /^\d+$/

function unauthorized(response: Response): void {
  response.status(401).json({ success: false, error: '未授权' })
}

export function requireAuth(request: Request, response: Response, next: NextFunction): void {
  const authorization = request.headers.authorization

  if (!authorization) {
    unauthorized(response)
    return
  }

  const match = BEARER_PATTERN.exec(authorization.trim())

  if (!match) {
    unauthorized(response)
    return
  }

  let secret: string

  try {
    secret = getJwtSecret()
  } catch (error) {
    console.error('JWT 配置错误：', error instanceof JwtConfigError ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
    return
  }

  try {
    // 明确只接受 HS256，防止算法混淆攻击
    const payload = verify(match[1], secret, { algorithms: ['HS256'] })

    if (typeof payload === 'string' || !payload.sub || !USER_ID_PATTERN.test(payload.sub)) {
      unauthorized(response)
      return
    }

    // 只信任 JWT 中的 subject，不信任请求体/URL 中的 user_id
    request.userId = payload.sub
    next()
  } catch {
    // 签名错误、过期、格式错误统一 401，不区分具体原因
    unauthorized(response)
  }
}
