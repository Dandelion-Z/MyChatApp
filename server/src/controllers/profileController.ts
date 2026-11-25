import type { Request, Response } from 'express'
import {
  InvalidCurrentPasswordError,
  InvalidNewPasswordError,
  PasswordUnchangedError,
  changePassword
} from '../services/authService'
import {
  FriendProfileNotFoundError,
  FriendshipNotFoundError,
  ProfileNotFoundError,
  getFriendProfile,
  getSelfProfile,
  setFriendRemark,
  updateProfile
} from '../services/profileService'
import { parseProfilePatch, parseRemark } from '../services/profileValidation'
import { COUNTRIES, COUNTRY_DATA_VERSION, COUNTRY_DATA_UPDATED_AT } from '../data/countries'
import { CN_PROVINCES, CN_REGION_DATA_UPDATED_AT, CN_REGION_DATA_VERSION } from '../data/regions'

const USER_ID_PATTERN = /^[1-9]\d*$/
const MAX_BIGINT = 9223372036854775807n

function parseUserId(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || !USER_ID_PATTERN.test(value)) {
    return null
  }

  if (BigInt(value) > MAX_BIGINT) {
    return null
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * GET /api/profile/me：只返回当前认证用户自己的资料。
 */
export async function getSelfProfileHandler(request: Request, response: Response): Promise<void> {
  const userId = request.userId

  if (!userId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  try {
    const profile = await getSelfProfile(userId)
    response.json({ success: true, data: profile })
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      response.status(404).json({ success: false, error: '用户不存在' })
      return
    }

    console.error('读取个人资料失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

/**
 * PATCH /api/profile/me：修改对象永远来自 JWT，忽略请求体中的任何用户标识。
 */
export async function updateSelfProfileHandler(
  request: Request,
  response: Response
): Promise<void> {
  const userId = request.userId

  if (!userId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  if (!isRecord(request.body)) {
    response.status(400).json({ success: false, error: '请求体必须是 JSON 对象' })
    return
  }

  try {
    const current = await getSelfProfile(userId)
    const parsed = parseProfilePatch(request.body, current)

    if (!parsed.ok) {
      response.status(400).json({ success: false, error: parsed.message })
      return
    }

    const profile = await updateProfile(userId, parsed.value)
    response.json({ success: true, data: profile })
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      response.status(404).json({ success: false, error: '用户不存在' })
      return
    }

    console.error('更新个人资料失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

/**
 * GET /api/profile/:userId：只有当前好友可以查看，且只返回当前用户给他设置的备注。
 */

/**
 * PATCH /api/profile/me/password：当前登录用户修改密码。
 * 身份只来自认证中间件；请求体中的 userId 一律忽略。
 * 密码与哈希不出现在响应与日志中。
 */
export async function changePasswordHandler(request: Request, response: Response): Promise<void> {
  const userId = request.userId

  if (!userId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const body: unknown = request.body

  if (!isRecord(body)) {
    response.status(400).json({ success: false, error: '请求内容格式不正确' })
    return
  }

  const { currentPassword, newPassword, currentRefreshToken } = body

  if (typeof currentPassword !== 'string' || currentPassword.trim().length === 0) {
    response.status(400).json({ success: false, error: '请输入原密码' })
    return
  }

  if (typeof newPassword !== 'string' || newPassword.length === 0) {
    response.status(400).json({ success: false, error: '请输入新密码' })
    return
  }

  if (
    currentRefreshToken !== undefined &&
    currentRefreshToken !== null &&
    typeof currentRefreshToken !== 'string'
  ) {
    response.status(400).json({ success: false, error: '请求内容格式不正确' })
    return
  }

  try {
    await changePassword(
      userId,
      currentPassword,
      newPassword,
      typeof currentRefreshToken === 'string' ? currentRefreshToken : null
    )
    response.json({ success: true })
  } catch (error) {
    if (
      error instanceof InvalidCurrentPasswordError ||
      error instanceof InvalidNewPasswordError ||
      error instanceof PasswordUnchangedError
    ) {
      response.status(400).json({ success: false, error: error.message })
      return
    }

    console.error('修改密码失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

export async function getFriendProfileHandler(request: Request, response: Response): Promise<void> {
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const friendUserId = parseUserId(request.params.userId)

  if (!friendUserId) {
    response.status(400).json({ success: false, error: '用户 ID 不合法' })
    return
  }

  try {
    const profile = await getFriendProfile(currentUserId, friendUserId)
    response.json({ success: true, data: profile })
  } catch (error) {
    if (error instanceof FriendProfileNotFoundError) {
      response.status(404).json({ success: false, error: '用户不存在或不是好友' })
      return
    }

    console.error('读取好友资料失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

/**
 * PATCH /api/friends/:friendId/remark：只改当前用户自己那一侧的备注。
 */
export async function updateFriendRemarkHandler(
  request: Request,
  response: Response
): Promise<void> {
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const friendUserId = parseUserId(request.params.friendId)

  if (!friendUserId) {
    response.status(400).json({ success: false, error: '好友 ID 不合法' })
    return
  }

  if (!isRecord(request.body)) {
    response.status(400).json({ success: false, error: '请求体必须是 JSON 对象' })
    return
  }

  const parsed = parseRemark(request.body.remark)

  if (!parsed.ok) {
    response.status(400).json({ success: false, error: parsed.message })
    return
  }

  try {
    const remark = await setFriendRemark(currentUserId, friendUserId, parsed.value)
    response.json({ success: true, data: { remark } })
  } catch (error) {
    if (error instanceof FriendshipNotFoundError) {
      response.status(404).json({ success: false, error: '好友关系不存在' })
      return
    }

    console.error('修改好友备注失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

/**
 * GET /api/profile/options：个人资料编辑所需的国家/地区与行政区划只读数据。
 * 客户端不保存自己的副本，避免与服务端数据版本不一致。
 */
export function getProfileOptionsHandler(_request: Request, response: Response): void {
  response.setHeader('Cache-Control', 'public, max-age=3600')
  response.json({
    success: true,
    data: {
      countries: COUNTRIES.map(({ code, name, nameEn }) => ({ code, name, nameEn })),
      provinces: CN_PROVINCES.map((province) => ({
        code: province.code,
        name: province.name,
        cities: province.cities.map((city) => ({ code: city.code, name: city.name }))
      })),
      versions: {
        country: { version: COUNTRY_DATA_VERSION, updatedAt: COUNTRY_DATA_UPDATED_AT },
        region: { version: CN_REGION_DATA_VERSION, updatedAt: CN_REGION_DATA_UPDATED_AT }
      }
    }
  })
}
