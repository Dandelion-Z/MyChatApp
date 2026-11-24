import type { AuthedRequest } from '../api/friends'
import { getFriends } from '../api/friends'
import { getMessagesAfter } from '../api/messages'
import type { LocalMessageInput } from '../../../shared/localMessages'
import { notifyLocalMessagesUpdated } from './store'

// 每页条数：服务端上限 100，避免一次加载大量消息
const PAGE_SIZE = 100
// 单个好友一次同步最多翻页数，防止服务端异常时无限循环
const MAX_PAGES_PER_FRIEND = 200
// 并发同步的好友数，避免登录后瞬间打满连接
const CONCURRENCY = 2

export type LocalSyncSummary = {
  /** 需要同步的好友数 */
  friends: number
  /** 实际写入本地库的新消息条数（重复消息不计入） */
  inserted: number
  /** 失败的好友数；失败时不推进该好友游标，下次登录会继续尝试 */
  failed: number
}

type FriendSyncResult = { inserted: number; failed: boolean }

/** 单个好友的本地历史同步进度（仅本次运行期有效） */
export type FriendHistorySyncState = 'pending' | 'syncing' | 'complete' | 'failed'

const friendSyncStates = new Map<string, FriendHistorySyncState>()

/**
 * 某个好友的本地历史同步是否尚未完成。
 *
 * 首次同步按时间升序写入，只有确认同步完整结束（complete）后，本地记录才覆盖
 * 服务端保留期内的全部历史；此前（排队/进行中/失败/尚未同步）本地记录都可能
 * 只覆盖历史中段，不能把本地游标当作分页起点。
 */
export function isFriendHistorySyncIncomplete(friendId: string): boolean {
  return friendSyncStates.get(friendId) !== 'complete'
}

/** 供界面查询某个好友当前的同步状态；没有同步记录时为 idle */
export function getFriendHistorySyncState(friendId: string): FriendHistorySyncState | 'idle' {
  return friendSyncStates.get(friendId) ?? 'idle'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * 同步单个好友的增量消息。
 *
 * 顺序保证：一页消息全部写入 SQLite 成功后才推进游标；
 * 写入失败直接抛出，由调用方保留旧游标，下次从同一位置重试。
 * 服务端已删除的过期消息不会再返回，游标只前进，不会触发重新下载。
 */
async function syncFriend(
  requestWithAuth: AuthedRequest,
  userId: string,
  friendId: string,
  initialCursor: string | undefined,
  signal: AbortSignal
): Promise<FriendSyncResult> {
  const api = window.api.localMessages
  // 没有游标说明是首次全量同步，这批消息属于历史记录；有游标说明是增量恢复的离线消息，计入未读
  const isIncremental = initialCursor !== undefined
  let cursor = initialCursor
  let inserted = 0

  for (let page = 0; page < MAX_PAGES_PER_FRIEND; page += 1) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const result = await getMessagesAfter(requestWithAuth, friendId, {
      limit: PAGE_SIZE,
      ...(cursor ? { after: cursor } : {}),
      signal
    })

    if (result.messages.length === 0) {
      return { inserted, failed: false }
    }

    const messages: LocalMessageInput[] = result.messages.map((message) => ({
      messageId: message.messageId,
      senderId: message.senderId,
      receiverId: message.receiverId,
      content: message.content,
      createdAt: message.createdAt,
      serverId: message.id
    }))

    const saved = await api.saveMany({
      userId,
      messages,
      ...(isIncremental ? { markUnread: true } : {})
    })

    if (!saved.ok) {
      throw new Error(`本地写入失败：${saved.reason}`)
    }

    inserted += saved.inserted

    const nextCursor = result.nextCursor

    if (!nextCursor) {
      notifyLocalMessagesUpdated(friendId)
      return { inserted, failed: false }
    }

    // 本页已成功落库，才推进游标；失败时保留旧游标等待下次重试
    const advanced = await api.setSyncCursor({ userId, peerId: friendId, cursor: nextCursor })

    if (!advanced.ok) {
      throw new Error('同步游标保存失败')
    }

    cursor = nextCursor
    notifyLocalMessagesUpdated(friendId)

    if (!result.hasMore) {
      return { inserted, failed: false }
    }
  }

  return { inserted, failed: false }
}

/**
 * 登录后启动本地记录增量同步。
 *
 * 1. 读取该账号每个聊天对象各自的同步游标；
 * 2. 按时间升序分页补拉服务端仍然保留的消息；
 * 3. 每页写入成功后才推进游标，失败保留进度，下次登录继续；
 * 4. 利用 messageId 去重，重复同步不会产生重复记录。
 */
export async function syncLocalMessages(
  requestWithAuth: AuthedRequest,
  userId: string,
  signal: AbortSignal
): Promise<LocalSyncSummary> {
  const api = window.api?.localMessages

  if (!api) {
    return { friends: 0, inserted: 0, failed: 0 }
  }

  const friends = await getFriends(requestWithAuth, signal)
  const { cursors } = await api.getSyncCursors(userId)

  // 好友列表不含自己；自我聊天（peerId = 当前账号）同样需要拉取，换设备登录后才能恢复备忘录
  const friendIds = friends.map((friend) => friend.id)

  if (!friendIds.includes(userId)) {
    friendIds.push(userId)
  }

  // 先把本轮要同步的好友标记为 pending：排队期间本地记录同样不完整
  for (const friendId of friendIds) {
    friendSyncStates.set(friendId, 'pending')
  }
  const queue = [...friendIds]
  let inserted = 0
  let failed = 0

  const worker = async (): Promise<void> => {
    for (let friendId = queue.shift(); friendId; friendId = queue.shift()) {
      if (signal.aborted) {
        return
      }

      friendSyncStates.set(friendId, 'syncing')

      try {
        const result = await syncFriend(
          requestWithAuth,
          userId,
          friendId,
          cursors[friendId],
          signal
        )

        friendSyncStates.set(friendId, 'complete')
        inserted += result.inserted
        failed += result.failed ? 1 : 0
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          return
        }

        friendSyncStates.set(friendId, 'failed')
        failed += 1
        console.warn('[localSync] 好友消息同步失败，保留游标待下次重试', error)
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker())
  await Promise.all(workers)

  return { friends: friendIds.length, inserted, failed }
}
