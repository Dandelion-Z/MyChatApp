import type { Request, Response } from 'express'
import {
  InvalidMessageCursorError,
  MessageUserNotFoundError,
  getMessageHistory,
  getMessagesAfter
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

  // 允许 friendId === 当前用户：自我聊天（个人备忘录）历史，仍由 JWT 身份决定查询主体

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

  // 增量同步游标：与 before 互斥，after 表示只返回该游标之后（更新）的消息
  const rawAfter = request.query.after
  let after: string | undefined

  if (rawAfter !== undefined) {
    if (typeof rawAfter !== 'string' || rawAfter.length === 0 || rawAfter.length > 512) {
      response.status(400).json({ success: false, error: '同步游标无效' })
      return
    }

    after = rawAfter
  }

  if (before !== undefined && after !== undefined) {
    response.status(400).json({ success: false, error: 'before 与 after 不能同时使用' })
    return
  }

  // 增量同步可以从保留期最早一条开始（不带 after），此时用 order=asc 明确方向
  const rawOrder = request.query.order
  let forward = after !== undefined

  if (rawOrder !== undefined) {
    if (rawOrder !== 'asc') {
      response.status(400).json({ success: false, error: 'order 只支持 asc' })
      return
    }

    forward = true
  }

  if (forward && before !== undefined) {
    response.status(400).json({ success: false, error: 'before 与 order=asc 不能同时使用' })
    return
  }

  try {
    const history = forward
      ? await getMessagesAfter(currentUserId, friendId, limit, after)
      : await getMessageHistory(currentUserId, friendId, limit, before)

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
