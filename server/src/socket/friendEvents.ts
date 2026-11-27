import { pool } from '../database/pool'
import { emitToUser } from './realtime'
import type { FriendRequestItem } from '../services/friendRequestService'

/**
 * 好友申请通过后的实时通知。
 *
 * 必须在服务端数据库事务提交成功之后调用：事务失败时任何一方都不应收到「已成为好友」。
 * 推送失败（对方离线、连接异常）由调用方记录日志即可，双方下次登录或刷新列表时
 * 会从数据库（好友关系 + 会话记录 + 申请状态）恢复，不依赖这条事件。
 */
export const FRIEND_ACCEPTED_EVENT = 'friend:accepted'

export type FriendAcceptedPayload = {
  /** 被同意的好友申请 ID */
  requestId: string
  /** 收到事件的一方是申请者还是同意者 */
  role: 'requester' | 'accepter'
  /** 事件中的对方资料：申请者收到同意者资料，同意者收到申请者资料 */
  friend: {
    id: string
    nickname: string
    avatarUrl: string | null
  }
}

type Profile = FriendAcceptedPayload['friend']

type ProfileRow = { id: string; nickname: string; avatar_url: string | null }

async function loadProfile(userId: string): Promise<Profile | null> {
  const result = await pool.query(
    'SELECT id, nickname, avatar_url FROM users WHERE id = $1 AND is_deleted = FALSE',
    [userId]
  )
  const row = result.rows[0] as ProfileRow | undefined

  if (!row) {
    return null
  }

  return {
    id: String(row.id),
    nickname: String(row.nickname),
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null
  }
}

/**
 * 通知双方好友关系已建立。
 *
 * @param accepterId 同意申请的一方（HTTP 请求的当前用户）
 * @param request 已提交的好友申请（direction 为 incoming，user 是申请者）
 */
export async function notifyFriendAccepted(
  accepterId: string,
  request: FriendRequestItem
): Promise<void> {
  if (request.direction !== 'incoming' || request.user.id === accepterId) {
    return
  }

  const requester: Profile = {
    id: request.user.id,
    nickname: request.user.nickname,
    avatarUrl: request.user.avatarUrl
  }

  // 申请者一侧需要同意者的资料（用于提示与本地会话条目），申请条目里没有，单独取一次
  const accepter = await loadProfile(accepterId)

  if (!accepter) {
    return
  }

  // 申请者：申请已通过，可以立刻开始聊天
  emitToUser(requester.id, FRIEND_ACCEPTED_EVENT, {
    requestId: request.id,
    role: 'requester',
    friend: accepter
  } satisfies FriendAcceptedPayload)

  // 同意者：同一账号的其他设备/窗口也需要刷新好友与会话列表
  emitToUser(accepterId, FRIEND_ACCEPTED_EVENT, {
    requestId: request.id,
    role: 'accepter',
    friend: requester
  } satisfies FriendAcceptedPayload)
}
