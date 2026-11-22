import type { AuthedRequest } from './friends'

export type MessageItem = {
  id: string
  messageId: string
  senderId: string
  receiverId: string
  content: string
  createdAt: string
}

export type MessageHistoryPage = {
  messages: MessageItem[]
  hasMore: boolean
  nextCursor: string | null
}

export type MessageHistoryResponse = {
  success: true
  data: MessageHistoryPage
}

export type GetMessageHistoryOptions = {
  /** 每页条数，服务端允许 1～100，默认 30 */
  limit?: number
  /** 只返回该游标之前（更早）的消息 */
  before?: string
  signal?: AbortSignal
}

/** 查询与指定好友的历史消息（时间升序，nextCursor 用于继续加载更早消息） */
export async function getMessageHistory(
  requestWithAuth: AuthedRequest,
  friendId: string,
  options: GetMessageHistoryOptions = {}
): Promise<MessageHistoryPage> {
  const { limit, before, signal } = options
  const search = new URLSearchParams()

  if (limit !== undefined) {
    search.set('limit', String(limit))
  }

  if (before) {
    search.set('before', before)
  }

  const query = search.toString()
  const response = await requestWithAuth<MessageHistoryResponse>(
    `/api/messages/${encodeURIComponent(friendId)}${query ? `?${query}` : ''}`,
    signal ? { signal } : undefined
  )

  return response.data
}
