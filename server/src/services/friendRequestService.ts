import { pool } from '../database/pool'
import { CannotAddSelfError, DuplicateFriendshipError, UserNotFoundError } from './friendService'
import type { FriendUser } from './friendService'

export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired'
export type FriendRequestDirection = 'incoming' | 'outgoing'

/** 一条好友申请：对方信息 + 方向 + 状态，前端据此决定操作按钮或状态文案 */
export type FriendRequestItem = {
  id: string
  direction: FriendRequestDirection
  status: FriendRequestStatus
  /** 申请的另一方：收到的申请是发送者，发出的申请是接收者 */
  user: FriendUser
  createdAt: string
  /** 接收方处理时间；pending 时为 null */
  handledAt: string | null
}

/** 好友申请有效期（天）：超过该时长仍未处理的申请视为过期 */
export const FRIEND_REQUEST_TTL_DAYS = 30

/** 申请列表接口的返回：列表 + 当前用户收到的待处理数量（用于「新的朋友」红点） */
export type FriendRequestListResult = {
  requests: FriendRequestItem[]
  pendingIncomingCount: number
}

export class DuplicateFriendRequestError extends Error {
  constructor() {
    super('已发送过好友申请，请等待对方处理')
    this.name = 'DuplicateFriendRequestError'
  }
}

export class ReverseFriendRequestError extends Error {
  constructor() {
    super('对方已向你发送好友申请，请到“新的朋友”中处理')
    this.name = 'ReverseFriendRequestError'
  }
}

export class FriendRequestNotFoundError extends Error {
  constructor() {
    super('好友申请不存在')
    this.name = 'FriendRequestNotFoundError'
  }
}

export class FriendRequestForbiddenError extends Error {
  constructor() {
    super('只能由接收方处理该申请')
    this.name = 'FriendRequestForbiddenError'
  }
}

export class FriendRequestStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FriendRequestStateError'
  }
}

/**
 * 懒过期（按用户对）：把两人之间超期的待处理申请标记为 expired。
 * 发送新申请前调用，让过期记录不再阻塞同方向的重复申请校验。
 */
async function expirePendingRequestsForPair(userId: string, peerId: string): Promise<void> {
  await pool.query(
    `UPDATE friend_requests
     SET status = 'expired', handled_at = CURRENT_TIMESTAMP
     WHERE status = 'pending'
       AND created_at < CURRENT_TIMESTAMP - make_interval(days => $3::int)
       AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))`,
    [userId, peerId, FRIEND_REQUEST_TTL_DAYS]
  )
}

/**
 * 懒过期（按用户）：把与当前用户相关的超期待处理申请标记为 expired。
 * 读取申请列表前调用；过期记录会以 expired 状态返回并继续保留。
 */
async function expirePendingRequestsForUser(userId: string): Promise<void> {
  await pool.query(
    `UPDATE friend_requests
     SET status = 'expired', handled_at = CURRENT_TIMESTAMP
     WHERE status = 'pending'
       AND created_at < CURRENT_TIMESTAMP - make_interval(days => $2::int)
       AND (sender_id = $1 OR receiver_id = $1)`,
    [userId, FRIEND_REQUEST_TTL_DAYS]
  )
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  )
}

type RequestRow = {
  id: unknown
  sender_id: unknown
  receiver_id: unknown
  status: unknown
  created_at: unknown
  handled_at: unknown
  peer_id: unknown
  nickname: unknown
  avatar_url: unknown
}

function toIso(value: unknown): string {
  return new Date(value as string).toISOString()
}

/** 头像地址统一映射为字符串或 null，避免把 pg 的 null 语义泄漏到接口层 */
function avatarUrlOf(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/** 数据库行 → 接口结构；方向以当前用户是接收方还是发送方判定 */
function mapRequestRow(row: RequestRow, currentUserId: string): FriendRequestItem {
  return {
    id: String(row.id),
    direction: String(row.sender_id) === currentUserId ? 'outgoing' : 'incoming',
    status: String(row.status) as FriendRequestStatus,
    user: {
      id: String(row.peer_id),
      nickname: String(row.nickname),
      avatarUrl: avatarUrlOf(row.avatar_url)
    },
    createdAt: toIso(row.created_at),
    handledAt: row.handled_at ? toIso(row.handled_at) : null
  }
}

const REQUEST_SELECT_SQL = `
  SELECT r.id, r.sender_id, r.receiver_id, r.status, r.created_at, r.handled_at,
         u.id AS peer_id, u.nickname, u.avatar_url
  FROM friend_requests r
  JOIN users u
    ON u.id = CASE WHEN r.sender_id = $2 THEN r.receiver_id ELSE r.sender_id END
`

/**
 * 发送好友申请。
 * 只做业务校验与落库，不建立好友关系；重复的待处理申请由部分唯一索引兜底。
 */
export async function createFriendRequest(
  currentUserId: string,
  targetUid: string
): Promise<FriendRequestItem> {
  // 只按公开 UID 精确查找，不再支持按登录用户名添加好友
  const targetResult = await pool.query(
    `SELECT id, nickname, avatar_url
     FROM users
     WHERE uid = $1 AND is_deleted = FALSE`,
    [targetUid]
  )

  const target = targetResult.rows[0]

  if (!target) {
    throw new UserNotFoundError()
  }

  const targetId = String(target.id)

  if (targetId === currentUserId) {
    throw new CannotAddSelfError()
  }

  // 懒过期：超过有效期的旧申请先失效，同方向才能重新发送
  await expirePendingRequestsForPair(currentUserId, targetId)

  // 已经是好友（任一方向存在即视为好友）时不再接受申请
  const friendship = await pool.query(
    `SELECT 1
     FROM friendships
     WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
    [currentUserId, targetId]
  )

  if ((friendship.rowCount ?? 0) > 0) {
    throw new DuplicateFriendshipError()
  }

  // 相同方向的待处理申请只允许一条
  const existing = await pool.query(
    `SELECT 1 FROM friend_requests
     WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'`,
    [currentUserId, targetId]
  )

  if ((existing.rowCount ?? 0) > 0) {
    throw new DuplicateFriendRequestError()
  }

  // 对方已经发来申请时，提示直接去处理，避免双方同时存在待处理申请
  const reverse = await pool.query(
    `SELECT 1 FROM friend_requests
     WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'`,
    [targetId, currentUserId]
  )

  if ((reverse.rowCount ?? 0) > 0) {
    throw new ReverseFriendRequestError()
  }

  try {
    const inserted = await pool.query(
      `INSERT INTO friend_requests (sender_id, receiver_id)
       VALUES ($1, $2)
       RETURNING id, sender_id, receiver_id, status, created_at, handled_at`,
      [currentUserId, targetId]
    )

    const row = inserted.rows[0]

    return {
      id: String(row.id),
      direction: 'outgoing',
      status: String(row.status) as FriendRequestStatus,
      user: {
        id: targetId,
        nickname: String(target.nickname),
        avatarUrl: avatarUrlOf(target.avatar_url)
      },
      createdAt: toIso(row.created_at),
      handledAt: row.handled_at ? toIso(row.handled_at) : null
    }
  } catch (error) {
    // 并发发送时唯一索引冲突，统一按“已发送过申请”处理
    if (isUniqueViolation(error)) {
      throw new DuplicateFriendRequestError()
    }

    throw error
  }
}

/**
 * 当前用户收到 + 发出的申请，统一按申请时间倒序。
 * 读取前先做懒过期，并统计收到的待处理数量供前端红点使用。
 */
export async function getFriendRequests(currentUserId: string): Promise<FriendRequestListResult> {
  await expirePendingRequestsForUser(currentUserId)

  const [listResult, countResult] = await Promise.all([
    pool.query(
      `${REQUEST_SELECT_SQL}
       WHERE (r.sender_id = $1 OR r.receiver_id = $1) AND u.is_deleted = FALSE
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 100`,
      [currentUserId, currentUserId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
       FROM friend_requests
       WHERE receiver_id = $1
         AND status = 'pending'
         AND created_at >= CURRENT_TIMESTAMP - make_interval(days => $2::int)`,
      [currentUserId, FRIEND_REQUEST_TTL_DAYS]
    )
  ])

  return {
    requests: (listResult.rows as RequestRow[]).map((row) => mapRequestRow(row, currentUserId)),
    pendingIncomingCount: Number(countResult.rows[0]?.count ?? 0)
  }
}

/**
 * 同意申请：同一事务内建立双向好友关系并更新申请状态。
 * 双向插入按 BIGINT 升序，避免与添加好友等其他事务交叉加锁导致死锁；
 * 已存在的方向用 ON CONFLICT 跳过，因此重复同意不会只建一侧。
 */
export async function acceptFriendRequest(
  currentUserId: string,
  requestId: string
): Promise<FriendRequestItem> {
  const client = await pool.connect()
  let committed = false

  try {
    await client.query('BEGIN')

    const locked = await client.query(`${REQUEST_SELECT_SQL} WHERE r.id = $1 FOR UPDATE OF r`, [
      requestId,
      currentUserId
    ])

    const row = locked.rows[0] as RequestRow | undefined

    if (!row) {
      throw new FriendRequestNotFoundError()
    }

    if (String(row.receiver_id) !== currentUserId) {
      throw new FriendRequestForbiddenError()
    }

    const status = String(row.status) as FriendRequestStatus

    if (status === 'rejected') {
      throw new FriendRequestStateError('该申请已被拒绝，无法同意')
    }

    if (status === 'expired') {
      throw new FriendRequestStateError('该申请已过期，无法同意')
    }

    let resultRow = row

    if (status === 'pending') {
      // 并发安全：锁行后再按数据库时间复核有效期，超期则先落库为 expired 再拒绝
      const expiry = await client.query(
        `SELECT created_at < CURRENT_TIMESTAMP - make_interval(days => $2::int) AS expired
         FROM friend_requests
         WHERE id = $1`,
        [requestId, FRIEND_REQUEST_TTL_DAYS]
      )

      if (expiry.rows[0]?.expired === true) {
        await client.query(
          `UPDATE friend_requests
           SET status = 'expired', handled_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [requestId]
        )
        await client.query('COMMIT')
        committed = true
        throw new FriendRequestStateError('该申请已过期，无法同意')
      }

      const senderId = String(row.sender_id)
      const receiverId = String(row.receiver_id)
      const [firstId, secondId] =
        BigInt(senderId) < BigInt(receiverId) ? [senderId, receiverId] : [receiverId, senderId]

      await client.query(
        `INSERT INTO friendships (user_id, friend_id)
         VALUES ($1, $2), ($3, $4)
         ON CONFLICT (user_id, friend_id) DO NOTHING`,
        [firstId, secondId, secondId, firstId]
      )

      const updated = await client.query(
        `UPDATE friend_requests
         SET status = 'accepted', handled_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, sender_id, receiver_id, status, created_at, handled_at`,
        [requestId]
      )

      resultRow = { ...row, ...updated.rows[0] }
    }

    await client.query('COMMIT')
    committed = true

    return mapRequestRow(resultRow, currentUserId)
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // 连接已断开时忽略回滚失败，保留最初导致失败的错误
      }
    }

    throw error
  } finally {
    client.release()
  }
}

/** 拒绝申请：只更新状态，不建立好友关系；重复拒绝按幂等处理 */
export async function rejectFriendRequest(
  currentUserId: string,
  requestId: string
): Promise<FriendRequestItem> {
  const client = await pool.connect()
  let committed = false

  try {
    await client.query('BEGIN')

    const locked = await client.query(`${REQUEST_SELECT_SQL} WHERE r.id = $1 FOR UPDATE OF r`, [
      requestId,
      currentUserId
    ])

    const row = locked.rows[0] as RequestRow | undefined

    if (!row) {
      throw new FriendRequestNotFoundError()
    }

    if (String(row.receiver_id) !== currentUserId) {
      throw new FriendRequestForbiddenError()
    }

    const status = String(row.status) as FriendRequestStatus

    if (status === 'accepted') {
      throw new FriendRequestStateError('该申请已同意，无法拒绝')
    }

    if (status === 'expired') {
      throw new FriendRequestStateError('该申请已过期，无法拒绝')
    }

    let resultRow = row

    if (status === 'pending') {
      // 并发安全：锁行后复核有效期，超期先落库为 expired 再拒绝
      const expiry = await client.query(
        `SELECT created_at < CURRENT_TIMESTAMP - make_interval(days => $2::int) AS expired
         FROM friend_requests
         WHERE id = $1`,
        [requestId, FRIEND_REQUEST_TTL_DAYS]
      )

      if (expiry.rows[0]?.expired === true) {
        await client.query(
          `UPDATE friend_requests
           SET status = 'expired', handled_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [requestId]
        )
        await client.query('COMMIT')
        committed = true
        throw new FriendRequestStateError('该申请已过期，无法拒绝')
      }

      const updated = await client.query(
        `UPDATE friend_requests
         SET status = 'rejected', handled_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, sender_id, receiver_id, status, created_at, handled_at`,
        [requestId]
      )

      resultRow = { ...row, ...updated.rows[0] }
    }

    await client.query('COMMIT')
    committed = true

    return mapRequestRow(resultRow, currentUserId)
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // 连接已断开时忽略回滚失败，保留最初导致失败的错误
      }
    }

    throw error
  } finally {
    client.release()
  }
}
