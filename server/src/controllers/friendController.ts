import type { Request, Response } from 'express'
import {
  CannotAddSelfError,
  DuplicateFriendshipError,
  FriendshipNotFoundError,
  UserNotFoundError,
  createFriendship,
  deleteFriendship,
  getFriends
} from '../services/friendService'

const USERNAME_PATTERN = /^[a-z0-9_]+$/
const FRIEND_ID_PATTERN = /^[1-9]\d*$/
const MAX_BIGINT = 9223372036854775807n

type ValidationResult = { ok: true; value: string } | { ok: false; message: string }

function fail(message: string): ValidationResult {
  return { ok: false, message }
}

export function validateFriendUsername(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('请求体必须是 JSON 对象')
  }

  const { username } = body as Record<string, unknown>

  if (typeof username !== 'string') {
    return fail('username 必须是字符串')
  }

  const normalizedUsername = username.trim().toLowerCase()

  if (normalizedUsername.length < 3 || normalizedUsername.length > 20) {
    return fail('username 长度必须为 3～20 个字符')
  }

  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    return fail('username 只能包含英文字母、数字和下划线')
  }

  return { ok: true, value: normalizedUsername }
}

export async function addFriend(request: Request, response: Response): Promise<void> {
  // 当前用户只能来自 JWT 中间件写入的 request.userId，绝不读取客户端提交的 user_id
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const validation = validateFriendUsername(request.body)

  if (!validation.ok) {
    response.status(400).json({ success: false, error: validation.message })
    return
  }

  try {
    const friend = await createFriendship(currentUserId, validation.value)
    response.status(201).json({ success: true, data: friend })
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      response.status(404).json({ success: false, error: '用户不存在' })
      return
    }

    if (error instanceof CannotAddSelfError) {
      response.status(400).json({ success: false, error: '不能添加自己为好友' })
      return
    }

    if (error instanceof DuplicateFriendshipError) {
      response.status(409).json({ success: false, error: '你们已经是好友' })
      return
    }

    console.error('添加好友失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
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
