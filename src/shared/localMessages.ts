/**
 * 本地聊天记录（SQLite）在主进程 / preload / 渲染进程之间共享的类型定义。
 * 这里只有类型，不包含任何运行时代码。
 */

/** 写入本地库的一条消息；字段沿用服务端消息结构 */
export type LocalMessageInput = {
  /** 服务端消息 ID，用于跨会话/重连去重 */
  messageId: string
  senderId: string
  receiverId: string
  content: string
  /** 服务端创建的微秒精度时间（ISO 字符串） */
  createdAt: string
  /** 服务端自增主键，可选；仅作辅助信息 */
  serverId?: string
}

/** 从本地库读出的一条消息（字段与写入结构一致） */
export type LocalMessageItem = LocalMessageInput

export type SaveLocalMessageRequest = {
  /** 本地账号 ID（多账号隔离键），即当前登录用户的 userId */
  userId: string
  message: LocalMessageInput
  /** 是否把这条消息记为未读（仅对收到的消息生效，自己是发送方时忽略） */
  markUnread?: boolean
}

/** 批量写入：增量同步按页落地，单条失败不影响整页重试语义 */
export type SaveLocalMessagesRequest = {
  userId: string
  messages: LocalMessageInput[]
  /** 是否把这些消息记为未读（增量补拉的离线消息使用；自己是发送方的消息忽略） */
  markUnread?: boolean
}

export type SaveLocalMessagesResult =
  { ok: true; inserted: number; received: number } | { ok: false; reason: string }

export type LocalMessageStats = {
  /** 当前账号的消息条数（仅统计该账号；未打开过数据库时为 0） */
  count: number
  /** 本地数据库占用的字节数（含 WAL），所有账号共享同一额度 */
  bytes: number
  /** 共享存储额度（字节） */
  quotaBytes: number
}

export type SaveLocalMessageResult = { ok: true; inserted: boolean } | { ok: false; reason: string }

/** 按账号 + 聊天对象读取本地历史（时间升序，游标用于继续读取更早的消息） */
export type ListLocalMessagesRequest = {
  userId: string
  peerId: string
  /** 每页条数，1～100，默认 30 */
  limit?: number
  /** 只返回该游标之前（更早）的消息 */
  before?: string
}

export type ListLocalMessagesResult = {
  messages: LocalMessageItem[]
  hasMore: boolean
  nextCursor: string | null
}

/** 每个账号 + 聊天对象各自独立的同步游标（服务端增量同步进度） */
export type SyncCursorsResult = {
  cursors: Record<string, string>
}

export type SetSyncCursorRequest = {
  userId: string
  /** 聊天对象（好友）ID */
  peerId: string
  cursor: string
}

export type SetSyncCursorResult = { ok: boolean }

export type LocalMessagesApi = {
  /** 保存一条消息；同一账号下重复的 messageId 会被忽略（不会重复入库） */
  save: (request: SaveLocalMessageRequest) => Promise<SaveLocalMessageResult>
  /** 批量保存（增量同步使用）；重复 messageId 自动忽略 */
  saveMany: (request: SaveLocalMessagesRequest) => Promise<SaveLocalMessagesResult>
  /** 按账号 + 聊天对象读取本地历史消息 */
  list: (request: ListLocalMessagesRequest) => Promise<ListLocalMessagesResult>
  /** 读取某个账号全部聊天对象的同步游标 */
  getSyncCursors: (userId: string) => Promise<SyncCursorsResult>
  /** 写入同步游标（仅在该页消息已成功落库后调用） */
  setSyncCursor: (request: SetSyncCursorRequest) => Promise<SetSyncCursorResult>
  /** 读取本地库的容量统计，便于诊断与后续界面使用 */
  getStats: () => Promise<LocalMessageStats>
  /** 读取某个账号的聊天列表（最近消息内容与时间来自 messages 表） */
  listChats: (userId: string) => Promise<ListLocalChatsResult>
  /** 确保聊天条目存在（双击头像 / 发送成功 / 收到消息 / 读取历史时调用） */
  ensureChat: (request: EnsureLocalChatRequest) => Promise<EnsureLocalChatResult>
  /** 打开聊天时更新最近打开时间；条目不存在则创建 */
  touchChat: (request: TouchLocalChatRequest) => Promise<TouchLocalChatResult>
  /** 读取某个账号的未读统计（总数 + 按会话拆分） */
  getUnreadSummary: (userId: string) => Promise<UnreadSummary>
  /** 把某个会话的未读全部标记为已读（只影响该会话） */
  markConversationRead: (
    request: MarkConversationReadRequest
  ) => Promise<MarkConversationReadResult>
  /** 设置会话的置顶 / 免打扰状态 */
  setChatFlags: (request: SetChatFlagsRequest) => Promise<SetChatFlagsResult>
  /** 删除聊天入口（隐藏），保留历史消息，并清除该会话未读 */
  deleteChat: (request: DeleteLocalChatRequest) => Promise<DeleteLocalChatResult>
  /** 删除好友后清理该好友相关的本地缓存（消息、会话条目、同步游标与未读） */
  deleteFriendData: (request: DeleteFriendDataRequest) => Promise<DeleteFriendDataResult>
  /** 列出本地仍保留数据的聊天对象，用于与服务端好友列表做差集核对 */
  listChatPeers: (userId: string) => Promise<ListChatPeersResult>
}

export type ListChatPeersResult = {
  /** 本地仍保留数据的聊天对象 ID（消息、会话条目、同步游标三处的并集） */
  peers: string[]
}

/** 本地聊天列表中的一条会话（只保存会话元数据，消息内容从 messages 表读取） */
export type LocalChatSummary = {
  peerId: string
  /** 会话条目首次创建时间（微秒） */
  createdAtUs: number
  /** 最近一次打开会话的时间（微秒）；用于无消息会话排序 */
  lastOpenedAtUs: number
  /** 最近一条消息内容；没有消息时为 null */
  lastMessageContent: string | null
  /** 最近一条消息时间（微秒）；没有消息时为 null */
  lastMessageAtUs: number | null
  /** 该会话的未读消息数（只统计收到的消息） */
  unreadCount: number
  /** 是否置顶：置顶会话始终排在普通会话之前 */
  isPinned: boolean
  /** 是否免打扰：只影响任务栏闪烁提醒，不影响消息接收与未读统计 */
  isMuted: boolean
}

export type ListLocalChatsResult = {
  chats: LocalChatSummary[]
}

export type EnsureLocalChatRequest = {
  userId: string
  peerId: string
}

export type EnsureLocalChatResult = { ok: true; created: boolean }

export type TouchLocalChatRequest = {
  userId: string
  peerId: string
  /** 打开时间（微秒）；缺省使用当前时间 */
  atUs?: number
}

export type TouchLocalChatResult = { ok: true }

/** 未读统计：总数 + 每个会话的数量（peerId -> 未读条数） */
export type UnreadSummary = {
  total: number
  byPeer: Record<string, number>
}

export type MarkConversationReadRequest = {
  userId: string
  /** 会话对方 ID */
  peerId: string
}

export type MarkConversationReadResult = { ok: true; cleared: number }

/** 消息列表管理：置顶 / 免打扰；只改会话条目，不动消息与未读 */
export type SetChatFlagsRequest = {
  userId: string
  peerId: string
  pinned?: boolean
  muted?: boolean
}

export type SetChatFlagsResult = { ok: boolean }

/** 删除聊天：隐藏会话入口并清除该会话未读，历史消息保留 */
export type DeleteLocalChatRequest = {
  userId: string
  peerId: string
}

export type DeleteLocalChatResult = { ok: boolean; clearedUnread: number }

/** 删除好友后的本地清理：删除双方消息、会话条目与同步游标，仅影响当前账号与当前好友 */
export type DeleteFriendDataRequest = {
  userId: string
  peerId: string
}

export type DeleteFriendDataResult = {
  ok: boolean
  deletedMessages: number
  clearedUnread: number
}
