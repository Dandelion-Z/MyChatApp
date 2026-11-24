import type { AuthedRequest } from './friends'

/** 服务端 user_conversations 的一行：当前账号在该会话上的状态与未读数量 */
export type ServerConversation = {
  peerId: string
  isPinned: boolean
  isMuted: boolean
  isHidden: boolean
  lastMessageAt: string | null
  lastMessageId: string | null
  lastActivityAt: string | null
  lastOpenedAt: string | null
  lastReadAt: string | null
  lastReadMessageId: string | null
  createdAt: string
  updatedAt: string
  version: string
  /** 对方发给我的、位于最后已读位置之后的未读条数；自我聊天恒为 0 */
  unreadCount: number
}

export type ConversationsResponse = {
  success: true
  conversations: ServerConversation[]
  /** 当前用户所有可见会话的未读总数 */
  unreadTotal: number
}

export type ConversationResponse = {
  success: true
  conversation: ServerConversation
}

/** 服务端会话状态中允许客户端修改的三个开关 */
export type ConversationStateChanges = {
  isPinned?: boolean
  isMuted?: boolean
  isHidden?: boolean
}

/**
 * 拉取服务端会话状态与未读统计。
 * 未读以 PostgreSQL 的已读位置为准，本地 SQLite 只作为离线兜底。
 */
export async function getConversations(
  requestWithAuth: AuthedRequest,
  options: { includeHidden?: boolean; signal?: AbortSignal } = {}
): Promise<ConversationsResponse> {
  const includeHidden = options.includeHidden === true ? 'true' : 'false'
  const query = `?includeHidden=${includeHidden}`

  return requestWithAuth<ConversationsResponse>(
    `/api/conversations${query}`,
    options.signal ? { signal: options.signal } : undefined
  )
}

export type ConversationReadState = {
  lastReadAt: string
  lastReadMessageId: string
  unreadCount: number
}

export type MarkConversationReadResponse = {
  success: true
  data: ConversationReadState
}

/**
 * 上报“已读到哪条消息”。
 * 服务端会用消息的真实 (created_at, id) 校验归属并只允许向前推进；
 * 这里传入的是服务端消息主键（本地 ChatMessage.serverId）。
 */
export async function markConversationReadOnServer(
  requestWithAuth: AuthedRequest,
  peerId: string,
  lastReadMessageId: string
): Promise<ConversationReadState> {
  const response = await requestWithAuth<MarkConversationReadResponse>(
    `/api/conversations/${encodeURIComponent(peerId)}/read`,
    {
      method: 'POST',
      body: { lastReadMessageId }
    }
  )

  return response.data
}

/**
 * 打开/创建与某个好友（或自己）的会话。
 * 服务端会更新 last_opened_at 并清除本侧隐藏位，返回最新的会话状态。
 */
export async function openConversationOnServer(
  requestWithAuth: AuthedRequest,
  peerId: string
): Promise<ServerConversation> {
  const response = await requestWithAuth<ConversationResponse>(
    `/api/conversations/${encodeURIComponent(peerId)}/open`,
    { method: 'POST' }
  )

  return response.conversation
}

/**
 * 修改会话的置顶 / 免打扰 / 隐藏状态。
 * 必须携带上次读到的 version 做乐观并发控制；冲突时服务端返回 409。
 */
export async function updateConversationOnServer(
  requestWithAuth: AuthedRequest,
  peerId: string,
  changes: ConversationStateChanges,
  version: string
): Promise<ServerConversation> {
  const response = await requestWithAuth<ConversationResponse>(
    `/api/conversations/${encodeURIComponent(peerId)}`,
    {
      method: 'PATCH',
      body: { ...changes, version }
    }
  )

  return response.conversation
}
