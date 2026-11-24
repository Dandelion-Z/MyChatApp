import type { LocalChatSummary } from '../../../shared/localMessages'

/**
 * 本地聊天列表（会话条目）的渲染端封装。
 *
 * 会话条目只保存 user_id / peer_id / created_at_us / last_opened_at_us，
 * 最近一条消息的内容与时间由主进程从 messages 表读取，避免重复存储。
 */

/** 读取某个账号的聊天列表；读取失败按空列表处理，不影响聊天主流程 */
export async function listLocalChats(userId: string | undefined): Promise<LocalChatSummary[]> {
  if (!userId) {
    return []
  }

  const api = window.api?.localMessages

  if (!api) {
    return []
  }

  try {
    const result = await api.listChats(userId)
    return result.chats
  } catch (error) {
    console.warn('[localMessages] 读取聊天列表失败', error)
    return []
  }
}

/** 确保会话条目存在（双击头像 / 发送成功 / 收到消息 / 读取历史时调用） */
export async function ensureLocalChat(userId: string | undefined, peerId: string): Promise<void> {
  if (!userId) {
    return
  }

  try {
    await window.api?.localMessages?.ensureChat({ userId, peerId })
  } catch (error) {
    console.warn('[localMessages] 创建聊天条目失败', error)
  }
}

/** 打开会话时更新最近打开时间；条目不存在时顺带创建 */
export async function touchLocalChat(userId: string | undefined, peerId: string): Promise<void> {
  if (!userId) {
    return
  }

  try {
    await window.api?.localMessages?.touchChat({ userId, peerId })
  } catch (error) {
    console.warn('[localMessages] 更新聊天打开时间失败', error)
  }
}

/** 设置会话置顶 / 免打扰；失败只记录告警，不阻断界面 */
export async function setLocalChatFlags(
  userId: string | undefined,
  peerId: string,
  flags: { pinned?: boolean; muted?: boolean }
): Promise<boolean> {
  if (!userId) {
    return false
  }

  try {
    const result = await window.api?.localMessages?.setChatFlags({ userId, peerId, ...flags })
    return result?.ok === true
  } catch (error) {
    console.warn('[localMessages] 更新会话管理状态失败', error)
    return false
  }
}

/**
 * 删除好友成功后清理本地缓存：消息、会话条目、同步游标与未读。
 * 返回清理的未读条数；失败返回 null，由调用方提示但不影响服务端删除结果。
 */
export async function deleteLocalFriendData(
  userId: string | undefined,
  peerId: string
): Promise<number | null> {
  if (!userId || userId === peerId) {
    return null
  }

  try {
    const result = await window.api?.localMessages?.deleteFriendData({ userId, peerId })
    return result?.ok ? result.clearedUnread : null
  } catch (error) {
    console.warn('[localMessages] 清理好友本地数据失败', error)
    return null
  }
}

/** 列出当前账号本地仍保留数据的全部聊天对象，用于与服务端好友列表做差集核对 */
export async function listLocalChatPeers(userId: string | undefined): Promise<string[]> {
  if (!userId) {
    return []
  }

  try {
    const result = await window.api?.localMessages?.listChatPeers(userId)
    return result?.peers ?? []
  } catch (error) {
    console.warn('[localMessages] 读取本地聊天对象失败', error)
    return []
  }
}

/** 删除聊天入口（隐藏），历史消息保留；返回清除的未读条数 */
export async function deleteLocalChat(
  userId: string | undefined,
  peerId: string
): Promise<number | null> {
  if (!userId) {
    return null
  }

  try {
    const result = await window.api?.localMessages?.deleteChat({ userId, peerId })
    return result?.ok ? result.clearedUnread : null
  } catch (error) {
    console.warn('[localMessages] 删除聊天失败', error)
    return null
  }
}
