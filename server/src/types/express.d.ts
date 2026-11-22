import 'express'

declare global {
  namespace Express {
    interface Request {
      /** 由 requireAuth 中间件写入的已认证用户 ID（来自 JWT 的 sub） */
      userId?: string
    }
  }
}
