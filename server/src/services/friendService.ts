import { pool } from '../database/pool'
import { lockUserPair } from './userPairLock'

export type FriendUser = {
  id: string
  username: string
  nickname: string
}

export type FriendListItem = {
  id: string
  username: string
  nickname: string
  createdAt: string
  /** 当前用户是否把该好友标为星标；只反映自己这一侧的关系记录 */
  isStarred: boolean
  /** 星标标记时间；未星标时为 null */
  starredAt: string | null
}

export type FriendStarState = {
  friendId: string
  isStarred: boolean
  starredAt: string | null
}

export class UserNotFoundError extends Error {
  constructor() {
    super('用户不存在')
    this.name = 'UserNotFoundError'
  }
}

export class CannotAddSelfError extends Error {
  constructor() {
    super('不能添加自己为好友')
    this.name = 'CannotAddSelfError'
  }
}

export class DuplicateFriendshipError extends Error {
  constructor() {
    super('你们已经是好友')
    this.name = 'DuplicateFriendshipError'
  }
}

export class FriendshipNotFoundError extends Error {
  constructor() {
    super('好友关系不存在')
    this.name = 'FriendshipNotFoundError'
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  )
}

export async function createFriendship(
  currentUserId: string,
  targetUsername: string
): Promise<FriendUser> {
  // 查找目标用户（排除已注销用户）
  const targetResult = await pool.query(
    `SELECT id, username, nickname
     FROM users
     WHERE username = $1 AND is_deleted = FALSE`,
    [targetUsername]
  )

  const target = targetResult.rows[0]

  if (!target) {
    throw new UserNotFoundError()
  }

  const targetId = String(target.id)

  if (targetId === currentUserId) {
    throw new CannotAddSelfError()
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // 固定插入顺序：按 BIGINT 数值升序，避免双方同时添加时交叉加锁导致死锁
    const [firstId, secondId] =
      BigInt(currentUserId) < BigInt(targetId)
        ? [currentUserId, targetId]
        : [targetId, currentUserId]

    // 双向记录必须使用同一个事务、同一个 client
    await client.query('INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2)', [
      firstId,
      secondId
    ])

    await client.query('INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2)', [
      secondId,
      firstId
    ])

    await client.query('COMMIT')
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // 连接已断开时忽略回滚失败，保留最初导致失败的错误
    }

    // friendships 复合主键冲突（任一方向已存在）都视为“已经是好友”
    if (isUniqueViolation(error)) {
      throw new DuplicateFriendshipError()
    }

    throw error
  } finally {
    client.release()
  }

  return {
    id: targetId,
    username: String(target.username),
    nickname: String(target.nickname)
  }
}

export async function getFriends(currentUserId: string): Promise<FriendListItem[]> {
  // 参数化查询：当前用户 ID 只来自 JWT；JOIN 用户表并过滤软删除用户
  const result = await pool.query(
    `SELECT u.id, u.username, u.nickname, f.created_at, f.is_starred, f.starred_at
     FROM friendships f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = $1 AND u.is_deleted = FALSE
     ORDER BY f.created_at DESC`,
    [currentUserId]
  )

  // BIGINT 的 id 保持字符串，created_at 转为 ISO 字符串的 createdAt
  return result.rows.map((row) => ({
    id: String(row.id),
    username: String(row.username),
    nickname: String(row.nickname),
    createdAt: new Date(row.created_at).toISOString(),
    isStarred: row.is_starred === true,
    starredAt: row.starred_at ? new Date(row.starred_at).toISOString() : null
  }))
}

export async function setFriendStarred(
  currentUserId: string,
  friendId: string,
  starred: boolean
): Promise<FriendStarState> {
  // 只更新当前用户自己的好友关系记录；对方那一侧完全不受影响
  const result = await pool.query(
    `UPDATE friendships
     SET is_starred = $3,
         starred_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END
     WHERE user_id = $1 AND friend_id = $2
     RETURNING is_starred, starred_at`,
    [currentUserId, friendId, starred]
  )

  const row = result.rows[0]

  if (!row) {
    throw new FriendshipNotFoundError()
  }

  return {
    friendId,
    isStarred: row.is_starred === true,
    starredAt: row.starred_at ? new Date(row.starred_at).toISOString() : null
  }
}

/**
 * 删除好友（连同双方云端聊天数据）。
 *
 * 永夜的产品规则：删除好友后，双方都不能再查看此前的聊天历史。
 * 因此必须在同一个事务内完成：
 * 1. 删除双向 friendships（星标字段随行删除）；
 * 2. 删除双方之间两个方向的全部 messages；
 * 3. 删除双方各自的 user_conversations 记录；
 * 4. 保留 friend_requests 等申请历史，不影响与其他人的会话。
 *
 * 与消息发送共用同一把用户对级锁：发送先取得锁时，删除会等其提交后再清理该消息；
 * 删除先取得锁时，等待中的发送会在好友校验阶段失败。
 */
export async function deleteFriendship(currentUserId: string, friendId: string): Promise<void> {
  const client = await pool.connect()
  let deletedCount: number

  try {
    await client.query('BEGIN')

    await lockUserPair(client, currentUserId, friendId)

    const first = await client.query(
      'DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2',
      [currentUserId, friendId]
    )

    const second = await client.query(
      'DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2',
      [friendId, currentUserId]
    )

    deletedCount = (first.rowCount ?? 0) + (second.rowCount ?? 0)

    if (deletedCount === 0) {
      // 两个方向都不存在，回滚并报告 404（不清理任何消息）
      await client.query('ROLLBACK')
    } else {
      await client.query(
        `DELETE FROM messages
         WHERE (sender_id = $1 AND receiver_id = $2)
            OR (sender_id = $2 AND receiver_id = $1)`,
        [currentUserId, friendId]
      )

      await client.query(
        `DELETE FROM user_conversations
         WHERE (user_id = $1 AND peer_id = $2)
            OR (user_id = $2 AND peer_id = $1)`,
        [currentUserId, friendId]
      )

      await client.query('COMMIT')
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // 连接已断开时忽略回滚失败，保留最初导致失败的错误
    }

    throw error
  } finally {
    client.release()
  }

  if (deletedCount === 0) {
    throw new FriendshipNotFoundError()
  }
}
