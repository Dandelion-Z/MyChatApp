import { pool } from '../database/pool'

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
    `SELECT u.id, u.username, u.nickname, f.created_at
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
    createdAt: new Date(row.created_at).toISOString()
  }))
}

export async function deleteFriendship(currentUserId: string, friendId: string): Promise<void> {
  // 与添加好友保持一致：按 BIGINT 数值升序确定固定的删除顺序
  const [firstId, secondId] =
    BigInt(currentUserId) < BigInt(friendId) ? [currentUserId, friendId] : [friendId, currentUserId]

  const client = await pool.connect()
  let deletedCount: number

  try {
    await client.query('BEGIN')

    const first = await client.query(
      'DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2',
      [firstId, secondId]
    )

    const second = await client.query(
      'DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2',
      [secondId, firstId]
    )

    deletedCount = (first.rowCount ?? 0) + (second.rowCount ?? 0)

    if (deletedCount === 0) {
      // 两个方向都不存在，回滚并报告 404
      await client.query('ROLLBACK')
    } else {
      // 即使原本只剩一个方向，另一个方向的 DELETE 也已执行，两条都会被清理
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
