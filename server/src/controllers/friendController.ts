import type { Request, Response } from 'express'
import {
  FriendshipNotFoundError,
  deleteFriendship,
  getFriends,
  setFriendStarred
} from '../services/friendService'

const UID_PATTERN = /^(?:[1-9]\d{4,18})$/
const FRIEND_ID_PATTERN = /^[1-9]\d*$/
const MAX_BIGINT = 9223372036854775807n

type ValidationResult = { ok: true; value: string } | { ok: false; message: string }

function fail(message: string): ValidationResult {
  return { ok: false, message }
}

/** 好友查找/添加只接受服务端分配的 UID（5 至 19 位纯数字、不以 0 开头），不再接受登录用户名 */
export function validateFriendUid(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('请求体必须是 JSON 对象')
  }

  const { uid } = body as Record<string, unknown>

  if (typeof uid !== 'string') {
    return fail('UID 必须是字符串')
  }

  const normalizedUid = uid.trim()

  if (!UID_PATTERN.test(normalizedUid)) {
    return fail('UID 格式不正确，应为 5 至 19 位数字且不能以 0 开头')
  }

  return { ok: true, value: normalizedUid }
}

export async function listFriends(request: Request, response: Response): Promise<void> {
  // 当前用户只能来自 JWT 中间件写入的 request.userId
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  try {
    const friends = await getFriends(currentUserId)
    response.status(200).json({ success: true, friends })
  } catch (error) {
    console.error('查询好友列表失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

export async function removeFriend(request: Request, response: Response): Promise<void> {
  // 当前用户只能来自 JWT 中间件写入的 request.userId
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const friendId = request.params.friendId

  if (typeof friendId !== 'string' || !FRIEND_ID_PATTERN.test(friendId)) {
    response.status(400).json({ success: false, error: 'friendId 格式不正确' })
    return
  }

  if (BigInt(friendId) > MAX_BIGINT) {
    response.status(400).json({ success: false, error: 'friendId 超出 BIGINT 范围' })
    return
  }

  if (friendId === currentUserId) {
    response.status(400).json({ success: false, error: '不能删除自己' })
    return
  }

  try {
    await deleteFriendship(currentUserId, friendId)
    response.status(200).json({ success: true, message: '好友删除成功' })
  } catch (error) {
    if (error instanceof FriendshipNotFoundError) {
      response.status(404).json({ success: false, error: '好友关系不存在' })
      return
    }

    console.error('删除好友失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

/** 校验并解析好友 ID（路径参数），与删除好友使用同一套规则 */
function validateFriendId(value: string | string[] | undefined): ValidationResult {
  if (typeof value !== 'string' || !FRIEND_ID_PATTERN.test(value)) {
    return fail('friendId 格式不正确')
  }

  if (BigInt(value) > MAX_BIGINT) {
    return fail('friendId 超出 BIGINT 范围')
  }

  return { ok: true, value }
}

export async function updateFriendStar(request: Request, response: Response): Promise<void> {
  // 当前用户只能来自 JWT 中间件写入的 request.userId
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const friendIdValidation = validateFriendId(request.params.friendId)

  if (!friendIdValidation.ok) {
    response.status(400).json({ success: false, error: friendIdValidation.message })
    return
  }

  if (friendIdValidation.value === currentUserId) {
    response.status(400).json({ success: false, error: '不能对自己设置星标' })
    return
  }

  const body = request.body

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    response.status(400).json({ success: false, error: '请求体必须是 JSON 对象' })
    return
  }

  const { starred } = body as Record<string, unknown>

  // 只接受明确的布尔值，避免 "false" 之类的字符串被误判为真
  if (typeof starred !== 'boolean') {
    response.status(400).json({ success: false, error: 'starred 必须是布尔值' })
    return
  }

  try {
    const state = await setFriendStarred(currentUserId, friendIdValidation.value, starred)
    response.status(200).json({ success: true, data: state })
  } catch (error) {
    if (error instanceof FriendshipNotFoundError) {
      response.status(404).json({ success: false, error: '好友关系不存在' })
      return
    }

    console.error('更新好友星标失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}
