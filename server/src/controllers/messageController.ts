import type { Request, Response } from 'express'
import {
  InvalidMessageCursorError,
  MessageUserNotFoundError,
  getMessageHistory
} from '../services/messageService'

const FRIEND_ID_PATTERN = /^[1-9]\d*$/
const LIMIT_PATTERN = /^\d+$/
const MAX_BIGINT = 9223372036854775807n
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

function parseLimit(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_LIMIT
  }

  if (typeof value !== 'string' || !LIMIT_PATTERN.test(value)) {
    return null
  }

  const limit = Number(value)

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return null
  }

  return limit
}

export async function listMessages(request: Request, response: Response): Promise<void> {
  // 当前用户只能来自 JWT 中间件写入的 request.userId
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const friendId = request.params.friendId

  if (
    typeof friendId !== 'string' ||
    !FRIEND_ID_PATTERN.test(friendId) ||
    friendId.length > 19 ||
    BigInt(friendId) > MAX_BIGINT
  ) {
    response.status(400).json({ success: false, error: 'friendId 格式不正确' })
    return
  }

  if (friendId === currentUserId) {
    response.status(400).json({ success: false, error: '不能查询与自己的消息' })
    return
  }

  const limit = parseLimit(request.query.limit)

  if (limit === null) {
    response.status(400).json({ success: false, error: 'limit 必须是 1～100 的整数' })
    return
  }

  const rawBefore = request.query.before
  let before: string | undefined

  if (rawBefore !== undefined) {
    if (typeof rawBefore !== 'string' || rawBefore.length === 0 || rawBefore.length > 512) {
      response.status(400).json({ success: false, error: '分页游标无效' })
      return
    }

    before = rawBefore
  }

  try {
    const history = await getMessageHistory(currentUserId, friendId, limit, before)
    response.status(200).json({ success: true, data: history })
  } catch (error) {
    if (error instanceof MessageUserNotFoundError) {
      response.status(404).json({ success: false, error: '用户不存在' })
      return
    }

    if (error instanceof InvalidMessageCursorError) {
      response.status(400).json({ success: false, error: '分页游标无效' })
      return
    }

    console.error('查询历史消息失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}
