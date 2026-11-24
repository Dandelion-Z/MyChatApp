import { Router } from 'express'
import {
  listConversationsHandler,
  markConversationReadHandler,
  openConversationHandler,
  updateConversationHandler
} from '../controllers/conversationController'
import { requireAuth } from '../middleware/authMiddleware'

export const conversationRouter = Router()

// 会话列表与写入接口都只作用于当前 JWT 用户自己的记录
conversationRouter.get('/', requireAuth, listConversationsHandler)
conversationRouter.post('/:peerId/open', requireAuth, openConversationHandler)
conversationRouter.post('/:peerId/read', requireAuth, markConversationReadHandler)
conversationRouter.patch('/:peerId', requireAuth, updateConversationHandler)
