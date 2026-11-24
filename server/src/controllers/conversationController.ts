import type { Request, Response } from 'express'
import {
  ConversationMessageNotFoundError,
  ConversationNotFoundError,
  ConversationPeerNotFoundError,
  ConversationPeerNotFriendError,
  ConversationSelfMuteError,
  ConversationVersionConflictError,
  listConversations,
  markConversationRead,
  openConversation,
  updateConversation
} from '../services/conversationService'

const PEER_ID_PATTERN = /^[1-9]\d*$/
const MAX_BIGINT = 9223372036854775807n

/**
 * 解析 includeHidden 查询参数。
 *
 * 只接受 "true" / "false"，其余值按非法参数处理，避免把其它字符串当作真值。
 */
function parseIncludeHidden(value: unknown): boolean | null {
  if (value === undefined) {
    return false
  }

  if (value === 'true') {
    return true
  }

  if (value === 'false') {
    return false
  }

  return null
}

/**
 * GET /api/conversations
 *
 * 只读取当前 JWT 用户的会话；用户 ID 来自认证中间件，不接受请求参数指定。
 */
export async function listConversationsHandler(
  request: Request,
  response: Response
): Promise<void> {
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const includeHidden = parseIncludeHidden(request.query.includeHidden)

  if (includeHidden === null) {
    response.status(400).json({ success: false, error: 'includeHidden 必须是 true 或 false' })
    return
  }

  try {
    const { conversations, unreadTotal } = await listConversations(currentUserId, includeHidden)
    response.json({ success: true, conversations, unreadTotal })
  } catch (error) {
    console.error('读取会话列表失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

function parsePeerId(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || !PEER_ID_PATTERN.test(value)) {
    return null
  }

  try {
    if (BigInt(value) > MAX_BIGINT) {
      return null
    }
  } catch {
    return null
  }

  return value
}

/** 版本号只接受非负安全整数或数字字符串，避免精度丢失 */
function parseVersion(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null
  }

  if (typeof value === 'string' && /^\d{1,19}$/.test(value)) {
    try {
      const parsed = BigInt(value)
      return parsed <= MAX_BIGINT ? parsed.toString() : null
    } catch {
      return null
    }
  }

  return null
}

/** 消息 ID 只接受正整数或数字字符串，且不超过 BIGINT 上限 */
function parseMessageId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }

  if (typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)) {
    try {
      const parsed = BigInt(value)
      return parsed <= MAX_BIGINT ? parsed.toString() : null
    } catch {
      return null
    }
  }

  return null
}

/**
 * POST /api/conversations/:peerId/open
 *
 * 打开或创建当前用户与好友的会话：更新 last_opened_at 并清除本侧隐藏位。
 * 自我聊天直接允许；普通聊天必须是双向好友，不能凭空创建与非好友的会话。
 */
export async function openConversationHandler(request: Request, response: Response): Promise<void> {
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const peerId = parsePeerId(request.params.peerId)

  if (!peerId) {
    response.status(400).json({ success: false, error: '好友 ID 不合法' })
    return
  }

  try {
    const conversation = await openConversation(currentUserId, peerId)
    response.json({ success: true, conversation })
  } catch (error) {
    if (error instanceof ConversationPeerNotFoundError) {
      response.status(404).json({ success: false, error: error.message })
      return
    }

    if (error instanceof ConversationPeerNotFriendError) {
      response.status(400).json({ success: false, error: error.message })
      return
    }

    console.error('打开会话失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

/**
 * PATCH /api/conversations/:peerId
 *
 * 修改当前用户自己的 is_pinned / is_muted / is_hidden。
 * 必须携带 version 做乐观并发控制；用户 ID 只来自 JWT，不接受请求体指定。
 */
export async function updateConversationHandler(
  request: Request,
  response: Response
): Promise<void> {
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const peerId = parsePeerId(request.params.peerId)

  if (!peerId) {
    response.status(400).json({ success: false, error: '好友 ID 不合法' })
    return
  }

  const body = request.body

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    response.status(400).json({ success: false, error: '请求内容格式不正确' })
    return
  }

  const record = body as Record<string, unknown>
  const changes: { isPinned?: boolean; isMuted?: boolean; isHidden?: boolean } = {}

  for (const key of ['isPinned', 'isMuted', 'isHidden'] as const) {
    const value = record[key]

    if (value === undefined) {
      continue
    }

    if (typeof value !== 'boolean') {
      response.status(400).json({ success: false, error: `${key} 必须是布尔值` })
      return
    }

    changes[key] = value
  }

  if (Object.keys(changes).length === 0) {
    response
      .status(400)
      .json({ success: false, error: '至少需要提供 isPinned、isMuted 或 isHidden 之一' })
    return
  }

  const version = parseVersion(record.version)

  if (version === null) {
    response.status(400).json({ success: false, error: 'version 必须是非负整数' })
    return
  }

  try {
    const conversation = await updateConversation(currentUserId, peerId, changes, version)
    response.json({ success: true, conversation })
  } catch (error) {
    if (error instanceof ConversationSelfMuteError) {
      response.status(400).json({ success: false, error: error.message })
      return
    }

    if (error instanceof ConversationNotFoundError) {
      response.status(404).json({ success: false, error: error.message })
      return
    }

    if (error instanceof ConversationVersionConflictError) {
      response.status(409).json({ success: false, error: error.message })
      return
    }

    console.error('更新会话状态失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

/**
 * POST /api/conversations/:peerId/read
 *
 * 标记当前用户在该会话中的最后已读消息。
 * 用户 ID 只来自 JWT；消息归属与真实 created_at 由服务端校验，客户端不能伪造时间。
 * 已读位置只能向前推进；自我聊天允许提交，未读数量恒为 0。
 */
export async function markConversationReadHandler(
  request: Request,
  response: Response
): Promise<void> {
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const peerId = parsePeerId(request.params.peerId)

  if (!peerId) {
    response.status(400).json({ success: false, error: '好友 ID 不合法' })
    return
  }

  const body = request.body

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    response.status(400).json({ success: false, error: '请求内容格式不正确' })
    return
  }

  const lastReadMessageId = parseMessageId((body as Record<string, unknown>).lastReadMessageId)

  if (lastReadMessageId === null) {
    response.status(400).json({ success: false, error: 'lastReadMessageId 必须是正整数' })
    return
  }

  try {
    const state = await markConversationRead(currentUserId, peerId, lastReadMessageId)
    response.json({ success: true, data: state })
  } catch (error) {
    if (
      error instanceof ConversationMessageNotFoundError ||
      error instanceof ConversationNotFoundError
    ) {
      response.status(404).json({ success: false, error: error.message })
      return
    }

    console.error('标记会话已读失败：', error)
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}
