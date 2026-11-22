import { Router } from 'express'
import { listMessages } from '../controllers/messageController'
import { requireAuth } from '../middleware/authMiddleware'

export const messageRouter = Router()

// 历史消息查询需要 JWT 身份认证
messageRouter.get('/:friendId', requireAuth, listMessages)
