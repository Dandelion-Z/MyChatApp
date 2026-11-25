import type { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import {
  InvalidAvatarFormatError,
  InvalidAvatarImageError,
  InvalidAvatarSizeError,
  MAX_AVATAR_UPLOAD_BYTES,
  clearUserAvatar,
  setUserAvatar
} from '../services/avatarService'
import { ProfileNotFoundError, getSelfProfile } from '../services/profileService'

const MAX_AVATAR_UPLOAD_MB = Math.floor(MAX_AVATAR_UPLOAD_BYTES / (1024 * 1024))

// 头像走内存缓冲：图片本身不大，压缩后立即落盘，不保留临时文件。
// 这里不按 MIME/扩展名筛类型：真实格式统一交给 sharp 解析后判断，
// 避免伪造 Content-Type 绕过白名单。
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_UPLOAD_BYTES, files: 1, fields: 4 }
})

/**
 * multipart/form-data 解析包装：把 multer 的错误统一转成 JSON 400，
 * 避免 Express 默认错误页暴露堆栈。
 */
export function avatarUploadMiddleware(
  request: Request,
  response: Response,
  next: NextFunction
): void {
  avatarUpload.single('avatar')(request, response, (error: unknown) => {
    if (!error) {
      next()
      return
    }

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        response
          .status(400)
          .json({ success: false, error: `图片大小不能超过 ${MAX_AVATAR_UPLOAD_MB}MB` })
        return
      }

      response.status(400).json({ success: false, error: '上传请求不合法' })
      return
    }

    console.error('解析头像上传失败：', error)
    response.status(400).json({ success: false, error: '上传请求不合法' })
  })
}

/** POST /api/profile/me/avatar：上传并统一压缩为 512×512 WebP，返回完整资料。 */
export async function uploadAvatarHandler(request: Request, response: Response): Promise<void> {
  const userId = request.userId

  if (!userId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  if (!request.file) {
    response.status(400).json({ success: false, error: '请选择要上传的图片' })
    return
  }

  try {
    await setUserAvatar(userId, request.file.buffer)
    const profile = await getSelfProfile(userId)
    response.json({ success: true, data: profile })
  } catch (error) {
    if (
      error instanceof InvalidAvatarImageError ||
      error instanceof InvalidAvatarFormatError ||
      error instanceof InvalidAvatarSizeError
    ) {
      response.status(400).json({ success: false, error: error.message })
      return
    }

    if (error instanceof ProfileNotFoundError) {
      response.status(404).json({ success: false, error: '用户不存在' })
      return
    }

    console.error('上传头像失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

/** DELETE /api/profile/me/avatar：恢复默认头像，返回完整资料。 */
export async function deleteAvatarHandler(request: Request, response: Response): Promise<void> {
  const userId = request.userId

  if (!userId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  try {
    await clearUserAvatar(userId)
    const profile = await getSelfProfile(userId)
    response.json({ success: true, data: profile })
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      response.status(404).json({ success: false, error: '用户不存在' })
      return
    }

    console.error('删除头像失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}
