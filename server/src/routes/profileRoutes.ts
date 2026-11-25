import { Router } from 'express'
import {
  avatarUploadMiddleware,
  deleteAvatarHandler,
  uploadAvatarHandler
} from '../controllers/avatarController'
import {
  changePasswordHandler,
  getFriendProfileHandler,
  getProfileOptionsHandler,
  getSelfProfileHandler,
  updateSelfProfileHandler
} from '../controllers/profileController'
import { requireAuth } from '../middleware/authMiddleware'

export const profileRouter = Router()

// 自己的资料：/me 必须注册在 /:userId 之前
profileRouter.get('/me', requireAuth, getSelfProfileHandler)
profileRouter.patch('/me', requireAuth, updateSelfProfileHandler)
// 修改密码：只允许通过原密码校验后更新当前账号
profileRouter.patch('/me/password', requireAuth, changePasswordHandler)
// 头像：multipart 上传，服务端统一压缩为 WebP；DELETE 恢复默认头像
profileRouter.post('/me/avatar', requireAuth, avatarUploadMiddleware, uploadAvatarHandler)
profileRouter.delete('/me/avatar', requireAuth, deleteAvatarHandler)
// 编辑资料用的国家/行政区划只读数据（无个人信息）
profileRouter.get('/options', requireAuth, getProfileOptionsHandler)
// 好友资料：仅限当前好友，返回值额外包含 remark
profileRouter.get('/:userId', requireAuth, getFriendProfileHandler)
