import type {
  ListLocalMessagesRequest,
  ListLocalMessagesResult,
  LocalMessageInput
} from '../../../shared/localMessages'

type ListLocalMessagesOptions = {
  /** 每页条数，1～100，默认 30 */
  limit?: number
  /** 只读取该游标之前（更早）的消息 */
  before?: string
}

/**
 * 把一条已确认的消息写入本地 SQLite。
 * 存储失败不影响聊天流程，只记录告警。
 */
export function saveLocalMessage(
  userId: string | undefined,
  message: LocalMessageInput,
  options: { markUnread?: boolean } = {}
): void {
  if (!userId) {
    return
  }

  const api = window.api?.localMessages

  if (!api) {
    return
  }

  void api
    .save({
      userId,
      message,
      ...(options.markUnread === true ? { markUnread: true } : {})
    })
    .then((result) => {
      if (!result.ok) {
        console.warn('[localMessages] 本地保存失败', result.reason)
      }
    })
    .catch((error) => {
      console.warn('[localMessages] 本地保存异常', error)
    })
}

/**
 * 按账号 + 聊天对象读取本地历史消息（时间升序）。
 * 游标由主进程生成，渲染端只负责原样回传，避免跨会话混用。
 */
export async function listLocalMessages(
  userId: string,
  peerId: string,
  options: ListLocalMessagesOptions = {}
): Promise<ListLocalMessagesResult> {
  const api = window.api?.localMessages

  if (!api) {
    return { messages: [], hasMore: false, nextCursor: null }
  }

  const request: ListLocalMessagesRequest = {
    userId,
    peerId,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.before ? { before: options.before } : {})
  }

  return api.list(request)
}

type LocalMessagesUpdatedListener = (peerId: string) => void

const updateListeners = new Set<LocalMessagesUpdatedListener>()

/**
 * 订阅“本地库被后台同步写入”的渲染进程内事件。
 * 只传递好友 ID，不携带消息本身；聊天界面收到后自行重读最新一页。
 */
export function subscribeLocalMessagesUpdated(listener: LocalMessagesUpdatedListener): () => void {
  updateListeners.add(listener)

  return () => {
    updateListeners.delete(listener)
  }
}

/** 后台同步每成功写入一页（并推进游标）后调用 */
export function notifyLocalMessagesUpdated(peerId: string): void {
  for (const listener of updateListeners) {
    try {
      listener(peerId)
    } catch (error) {
      console.warn('[localMessages] 本地消息更新通知处理异常', error)
    }
  }
}

/** 保存消息并等待主进程落库完成；用于需要立即刷新未读角标的场景 */
export async function saveLocalMessageAsync(
  userId: string | undefined,
  message: LocalMessageInput,
  options: { markUnread?: boolean } = {}
): Promise<void> {
  if (!userId) {
    return
  }

  const api = window.api?.localMessages

  if (!api) {
    return
  }

  try {
    await api.save({
      userId,
      message,
      ...(options.markUnread === true ? { markUnread: true } : {})
    })
  } catch (error) {
    console.warn('[localMessages] 保存本地消息失败', error)
  }
}

/** 批量保存消息并等待落库完成；重连补拉时用来恢复离线消息与未读计数 */
export async function saveLocalMessagesAsync(
  userId: string | undefined,
  messages: LocalMessageInput[],
  options: { markUnread?: boolean } = {}
): Promise<void> {
  if (!userId || messages.length === 0) {
    return
  }

  const api = window.api?.localMessages

  if (!api) {
    return
  }

  try {
    await api.saveMany({
      userId,
      messages,
      ...(options.markUnread === true ? { markUnread: true } : {})
    })
  } catch (error) {
    console.warn('[localMessages] 批量保存本地消息失败', error)
  }
}

/** 读取未读统计（总数 + 按会话）；失败按 0 处理，不影响聊天主流程 */
export async function getUnreadSummary(
  userId: string | undefined
): Promise<{ total: number; byPeer: Record<string, number> }> {
  if (!userId) {
    return { total: 0, byPeer: {} }
  }

  try {
    const summary = await window.api?.localMessages?.getUnreadSummary(userId)

    return summary ?? { total: 0, byPeer: {} }
  } catch (error) {
    console.warn('[localMessages] 读取未读统计失败', error)
    return { total: 0, byPeer: {} }
  }
}

/** 把某个会话标记为已读（只影响该会话） */
export async function markConversationRead(
  userId: string | undefined,
  peerId: string
): Promise<void> {
  if (!userId) {
    return
  }

  try {
    await window.api?.localMessages?.markConversationRead({ userId, peerId })
  } catch (error) {
    console.warn('[localMessages] 标记会话已读失败', error)
  }
}
