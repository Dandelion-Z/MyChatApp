import { Router } from 'express'
import { listFriends, removeFriend, updateFriendStar } from '../controllers/friendController'
import {
  acceptFriendRequestHandler,
  listFriendRequests,
  rejectFriendRequestHandler,
  sendFriendRequest
} from '../controllers/friendRequestController'
import { updateFriendRemarkHandler } from '../controllers/profileController'
import { requireAuth } from '../middleware/authMiddleware'

export const friendRouter = Router()

// 所有好友相关接口都需要 JWT 身份认证。
// 注意：不存在“按 UID 直接建立好友关系”的接口，新增好友必须走好友申请并获对方同意。
friendRouter.get('/', requireAuth, listFriends)
friendRouter.delete('/:friendId', requireAuth, removeFriend)
// 星标作用于当前用户自己的好友关系记录（PUT 表示整体设置，幂等）
friendRouter.put('/:friendId/star', requireAuth, updateFriendStar)
// 备注同样按当前用户自己那一侧的好友关系记录保存
friendRouter.patch('/:friendId/remark', requireAuth, updateFriendRemarkHandler)

// 好友申请：独立列表，发送后需接收方同意才建立好友关系
friendRouter.get('/requests', requireAuth, listFriendRequests)
friendRouter.post('/requests', requireAuth, sendFriendRequest)
friendRouter.post('/requests/:requestId/accept', requireAuth, acceptFriendRequestHandler)
friendRouter.post('/requests/:requestId/reject', requireAuth, rejectFriendRequestHandler)
