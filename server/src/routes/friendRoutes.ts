import { Router } from 'express'
import { addFriend, listFriends, removeFriend } from '../controllers/friendController'
import { requireAuth } from '../middleware/authMiddleware'

export const friendRouter = Router()

// 所有好友相关接口都需要 JWT 身份认证
friendRouter.post('/', requireAuth, addFriend)
friendRouter.get('/', requireAuth, listFriends)
friendRouter.delete('/:friendId', requireAuth, removeFriend)
