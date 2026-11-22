import type { Socket } from 'socket.io'
import {
  MessageIdConflictError,
  MessageNotFriendError,
  MessageUserNotFoundError,
  sendMessage
} from '../services/messageService'
import type { MessageItem } from '../services/messageService'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_PATTERN = /^[1-9]\d*$/
const MAX_BIGINT = 9223372036854775807n
const MAX_CONTENT_LENGTH = 2000

export type MessageSendAck =
  { ok: true; message: MessageItem } | { ok: false; code: string; message: string }

type ParsedPayload = {
  toUserId: string
  messageId: string
  content: string
}

type ValidationResult =
  { ok: true; value: ParsedPayload } | { ok: false; code: string; message: string }

type RecipientSocketResolver = (userId: string) => Socket | undefined

function fail(code: string, message: string): ValidationResult {
  return { ok: false, code, message }
}

function validatePayload(payload: unknown): ValidationResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return fail('INVALID_PAYLOAD', '消息参数必须是对象')
  }

  const { toUserId, messageId, content } = payload as Record<string, unknown>

  if (
    typeof toUserId !== 'string' ||
    !ID_PATTERN.test(toUserId) ||
    toUserId.length > 19 ||
    BigInt(toUserId) > MAX_BIGINT
  ) {
    return fail('INVALID_RECEIVER', '接收者 ID 格式不正确')
  }

  if (typeof messageId !== 'string' || !UUID_PATTERN.test(messageId)) {
    return fail('INVALID_MESSAGE_ID', 'messageId 必须是合法的 UUID')
  }

  if (typeof content !== 'string') {
    return fail('INVALID_CONTENT', '消息内容必须是字符串')
  }

  const normalizedContent = content.trim()

  if (normalizedContent.length === 0) {
    return fail('INVALID_CONTENT', '消息内容不能为空白')
  }

  if (normalizedContent.length > MAX_CONTENT_LENGTH) {
    return fail('INVALID_CONTENT', `消息内容不能超过 ${MAX_CONTENT_LENGTH} 个字符`)
  }

  return {
    ok: true,
    value: { toUserId, messageId, content: normalizedContent }
  }
}

export function registerMessageHandler(
  socket: Socket,
  senderId: string,
  resolveRecipientSocket: RecipientSocketResolver
): void {
  socket.on('message:send', async (payload: unknown, ack: unknown) => {
    // ACK 由客户端提供；没有 ack 回调时无法确认结果，直接忽略
    if (typeof ack !== 'function') {
      return
    }

    const respond = (response: MessageSendAck): void => {
      try {
        ;(ack as (result: MessageSendAck) => void)(response)
      } catch {
        // 客户端恰好断开时 ACK 可能失败；消息已经按数据库结果处理
      }
    }

    const validation = validatePayload(payload)

    if (!validation.ok) {
      respond({ ok: false, code: validation.code, message: validation.message })
      return
    }

    const { toUserId, messageId, content } = validation.value

    if (toUserId === senderId) {
      respond({ ok: false, code: 'INVALID_RECEIVER', message: '不能给自己发送消息' })
      return
    }

    try {
      const result = await sendMessage(senderId, toUserId, messageId, content)

      respond({ ok: true, message: result.message })

      // 只有首次成功写入才推送；重复请求只返回 ACK
      if (result.created) {
        try {
          const recipientSocket = resolveRecipientSocket(toUserId)

          if (recipientSocket?.connected) {
            recipientSocket.emit('message:new', result.message)
          }
        } catch (error) {
          // 推送失败不能把已提交的消息判定为发送失败
          console.error('推送新消息失败：', error instanceof Error ? error.message : String(error))
        }
      }
    } catch (error) {
      if (error instanceof MessageUserNotFoundError) {
        respond({ ok: false, code: 'USER_NOT_FOUND', message: '接收用户不存在或已注销' })
        return
      }

      if (error instanceof MessageNotFriendError) {
        respond({ ok: false, code: 'NOT_FRIEND', message: '你们已经不是好友，无法发送消息' })
        return
      }

      if (error instanceof MessageIdConflictError) {
        respond({ ok: false, code: 'MESSAGE_ID_CONFLICT', message: 'messageId 已被其他消息使用' })
        return
      }

      console.error('发送消息失败：', error instanceof Error ? error.message : String(error))
      respond({ ok: false, code: 'INTERNAL_ERROR', message: '服务器内部错误' })
    }
  })
}
