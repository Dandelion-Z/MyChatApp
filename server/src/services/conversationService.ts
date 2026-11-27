import type { PoolClient } from 'pg'
import { pool } from '../database/pool'
import { lockUserPair } from './userPairLock'

/**
 * 用户会话。
 *
 * 会话以 (user_id, peer_id) 为键：普通聊天双方各一行，自我聊天 peer_id = user_id。
 * 消息发送会维护最近消息字段；本模块提供查询、打开、状态写入、已读位置推进与未读数量计算。
 * 未读数量不落库，始终由“最后已读位置”和消息表实时聚合得出。
 */
export type ConversationItem = {
  peerId: string
  isPinned: boolean
  isMuted: boolean
  isHidden: boolean
  lastMessageAt: string | null
  lastMessageId: string | null
  lastActivityAt: string
  lastOpenedAt: string | null
  lastReadAt: string | null
  lastReadMessageId: string | null
  createdAt: string
  updatedAt: string
  version: string
}

/** 会话列表项：在会话状态之外附带由消息聚合出的未读数量 */
export type ConversationWithUnread = ConversationItem & { unreadCount: number }

export type ConversationListResult = {
  conversations: ConversationWithUnread[]
  unreadTotal: number
}

/** 标记已读后的权威位置与该会话当前未读数量 */
export type ConversationReadState = {
  lastReadAt: string | null
  lastReadMessageId: string | null
  unreadCount: number
}

export class ConversationPeerNotFoundError extends Error {
  constructor() {
    super('用户不存在')
    this.name = 'ConversationPeerNotFoundError'
  }
}

export class ConversationPeerNotFriendError extends Error {
  constructor() {
    super('对方不是你的好友，无法创建会话')
    this.name = 'ConversationPeerNotFriendError'
  }
}

export class ConversationNotFoundError extends Error {
  constructor() {
    super('会话不存在')
    this.name = 'ConversationNotFoundError'
  }
}

export class ConversationVersionConflictError extends Error {
  constructor() {
    super('会话已被其他操作更新，请刷新后重试')
    this.name = 'ConversationVersionConflictError'
  }
}

export class ConversationSelfMuteError extends Error {
  constructor() {
    super('自我聊天不能开启免打扰')
    this.name = 'ConversationSelfMuteError'
  }
}

export class ConversationMessageNotFoundError extends Error {
  constructor() {
    super('消息不存在')
    this.name = 'ConversationMessageNotFoundError'
  }
}

type ConversationRow = {
  peer_id: string
  is_pinned: boolean
  is_muted: boolean
  is_hidden: boolean
  last_message_at: Date | string | null
  last_message_id: string | null
  last_activity_at: Date | string
  last_opened_at: Date | string | null
  last_read_at: Date | string | null
  last_read_message_id: string | null
  created_at: Date | string
  updated_at: Date | string
  version: string
}

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toConversationItem(row: ConversationRow): ConversationItem {
  return {
    peerId: String(row.peer_id),
    isPinned: row.is_pinned === true,
    isMuted: row.is_muted === true,
    isHidden: row.is_hidden === true,
    lastMessageAt: toIso(row.last_message_at),
    lastMessageId: row.last_message_id === null ? null : String(row.last_message_id),
    lastActivityAt: toIso(row.last_activity_at) ?? new Date(0).toISOString(),
    lastOpenedAt: toIso(row.last_opened_at),
    lastReadAt: toIso(row.last_read_at),
    lastReadMessageId: row.last_read_message_id === null ? null : String(row.last_read_message_id),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
    version: String(row.version)
  }
}

/**
 * 读取当前账号的会话列表，并附带每个会话的未读数量。
 *
 * 排序：置顶优先，置顶与普通会话内部均按最新活动时间倒序；peer_id 作为稳定的
 * 第三排序键，保证同一时间戳下分页/重复请求的顺序一致。
 * 默认过滤 is_hidden = TRUE（“删除聊天”只隐藏入口），includeHidden 为 true 时一并返回。
 * 只能查询 currentUserId 自己的记录，调用方不得把用户 ID 作为请求参数传入。
 *
 * 未读数以 last_read_at + last_read_message_id 为权威位置，只统计 peer 发给自己的消息，
 * 使用 (created_at, id) 复合比较，保证同一时间戳下的消息不会漏算；
 * 已读位置为空时统计当前保留范围内的全部接收消息；自我聊天恒为 0。
 * unreadTotal 为本次返回的可见会话之和（默认即排除隐藏会话）。
 */
export async function listConversations(
  currentUserId: string,
  includeHidden: boolean
): Promise<ConversationListResult> {
  const result = await pool.query<ConversationRow & { unread_count: number }>(
    `SELECT
       c.peer_id,
       c.is_pinned,
       c.is_muted,
       c.is_hidden,
       c.last_message_at,
       c.last_message_id,
       c.last_activity_at,
       c.last_opened_at,
       c.last_read_at,
       c.last_read_message_id,
       c.created_at,
       c.updated_at,
       c.version,
       CASE
         WHEN c.peer_id = c.user_id THEN 0
         ELSE COALESCE(unread.unread_count, 0)
       END AS unread_count
     FROM user_conversations c
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS unread_count
       FROM messages m
       WHERE m.receiver_id = c.user_id
         AND m.sender_id = c.peer_id
         AND (
           c.last_read_at IS NULL
           OR c.last_read_message_id IS NULL
           OR (m.created_at, m.id) > (c.last_read_at, c.last_read_message_id)
         )
     ) unread ON TRUE
     WHERE c.user_id = $1
       AND ($2::boolean OR c.is_hidden = FALSE)
     ORDER BY c.is_pinned DESC, c.last_activity_at DESC, c.peer_id ASC`,
    [currentUserId, includeHidden]
  )

  const conversations = result.rows.map((row) => ({
    ...toConversationItem(row),
    unreadCount: Number(row.unread_count)
  }))

  const unreadTotal = conversations.reduce(
    (total, conversation) => total + conversation.unreadCount,
    0
  )

  return { conversations, unreadTotal }
}

const CONVERSATION_COLUMNS = `peer_id,
       is_pinned,
       is_muted,
       is_hidden,
       last_message_at,
       last_message_id,
       last_activity_at,
       last_opened_at,
       last_read_at,
       last_read_message_id,
       created_at,
       updated_at,
       version`

/**
 * 打开（或创建）当前用户与指定好友的会话。
 *
 * - 自我聊天直接允许；普通聊天必须双方好友关系都存在，不能凭空创建与非好友的会话；
 * - 更新 last_opened_at、清除本侧的 is_hidden；
 * - 不触碰置顶、免打扰、已读位置与最近消息字段；
 * - 已存在记录时 version 递增，供客户端感知状态变化。
 */
export async function openConversation(
  currentUserId: string,
  peerId: string
): Promise<ConversationItem> {
  const peer = await pool.query('SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE', [
    peerId
  ])

  if (peer.rowCount === 0) {
    throw new ConversationPeerNotFoundError()
  }

  if (peerId !== currentUserId) {
    const friendship = await pool.query(
      `SELECT 1 FROM friendships
       WHERE (user_id = $1 AND friend_id = $2)
          OR (user_id = $2 AND friend_id = $1)`,
      [currentUserId, peerId]
    )

    if ((friendship.rowCount ?? 0) < 2) {
      throw new ConversationPeerNotFriendError()
    }
  }

  const result = await pool.query<ConversationRow>(
    `INSERT INTO user_conversations (user_id, peer_id, last_opened_at, is_hidden, created_at, updated_at)
     VALUES ($1, $2, clock_timestamp(), FALSE, clock_timestamp(), clock_timestamp())
     ON CONFLICT (user_id, peer_id) DO UPDATE
     SET last_opened_at = clock_timestamp(),
         is_hidden = FALSE,
         updated_at = clock_timestamp(),
         version = user_conversations.version + 1
     RETURNING ${CONVERSATION_COLUMNS}`,
    [currentUserId, peerId]
  )

  return toConversationItem(result.rows[0])
}

/**
 * 好友申请通过时，为双方同时建立同一条 1V1 会话。
 *
 * - 必须在调用方的事务中执行：好友关系、好友申请状态、双方会话记录要一起提交；
 * - 只保证双方各有一行记录，不修改任何展示状态（置顶 / 免打扰 / 已读位置 / version），
 *   已存在时保持原状，因此重复同意同一申请不会产生重复会话，也不会覆盖用户设置；
 * - 与 openConversation 共用 user_conversations 表与 (user_id, peer_id) 主键，
 *   客户端随后仍通过会话列表接口读取，无需新增接口。
 */
export async function ensureFriendConversations(
  client: PoolClient,
  firstUserId: string,
  secondUserId: string
): Promise<void> {
  if (firstUserId === secondUserId) {
    return
  }

  await client.query(
    `INSERT INTO user_conversations (user_id, peer_id, is_hidden, last_activity_at, created_at, updated_at)
     VALUES ($1, $2, FALSE, clock_timestamp(), clock_timestamp(), clock_timestamp()),
            ($2, $1, FALSE, clock_timestamp(), clock_timestamp(), clock_timestamp())
     ON CONFLICT (user_id, peer_id) DO NOTHING`,
    [firstUserId, secondUserId]
  )
}

export type ConversationStateChanges = {
  isPinned?: boolean
  isMuted?: boolean
  isHidden?: boolean
}

/**
 * 修改当前用户自己的会话状态（置顶 / 免打扰 / 隐藏）。
 *
 * 使用 version 做乐观并发控制：只有客户端持有的版本与服务端一致时才写入，
 * 成功后 version 递增；旧版本请求不会覆盖较新的状态。
 * 自我聊天不允许开启免打扰。
 */
export async function updateConversation(
  currentUserId: string,
  peerId: string,
  changes: ConversationStateChanges,
  expectedVersion: string
): Promise<ConversationItem> {
  if (peerId === currentUserId && changes.isMuted === true) {
    throw new ConversationSelfMuteError()
  }

  const assignments: string[] = []
  const values: Array<string | boolean> = [currentUserId, peerId, expectedVersion]

  if (changes.isPinned !== undefined) {
    values.push(changes.isPinned)
    assignments.push(`is_pinned = $${values.length}`)
  }

  if (changes.isMuted !== undefined) {
    values.push(changes.isMuted)
    assignments.push(`is_muted = $${values.length}`)
  }

  if (changes.isHidden !== undefined) {
    values.push(changes.isHidden)
    assignments.push(`is_hidden = $${values.length}`)
  }

  if (assignments.length === 0) {
    throw new ConversationNotFoundError()
  }

  const result = await pool.query<ConversationRow>(
    `UPDATE user_conversations
     SET ${assignments.join(', ')},
         version = version + 1,
         updated_at = clock_timestamp()
     WHERE user_id = $1 AND peer_id = $2 AND version = $3::bigint
     RETURNING ${CONVERSATION_COLUMNS}`,
    values
  )

  if (result.rowCount === 1) {
    return toConversationItem(result.rows[0])
  }

  const existing = await pool.query(
    'SELECT 1 FROM user_conversations WHERE user_id = $1 AND peer_id = $2',
    [currentUserId, peerId]
  )

  if (existing.rowCount === 0) {
    throw new ConversationNotFoundError()
  }

  throw new ConversationVersionConflictError()
}

type MessagePositionRow = {
  id: string
  sender_id: string
  receiver_id: string
}

/**
 * 计算某个会话的未读数量。
 *
 * 只统计 peer 发给当前用户、且 (created_at, id) 严格晚于会话中最后已读位置的消息；
 * 比较完全在数据库内完成，避免把 timestamptz 经 JS Date 往返时丢失微秒精度。
 * 自我聊天恒为 0；未读数量不做持久化，避免与消息表产生不一致的计数器。
 */
async function countUnreadMessages(
  client: PoolClient,
  currentUserId: string,
  peerId: string
): Promise<number> {
  if (peerId === currentUserId) {
    return 0
  }

  const result = await client.query<{ unread_count: number }>(
    `SELECT COUNT(*)::int AS unread_count
     FROM messages m
     JOIN user_conversations c
       ON c.user_id = $1 AND c.peer_id = $2
     WHERE m.receiver_id = $1
       AND m.sender_id = $2
       AND (
         c.last_read_at IS NULL
         OR c.last_read_message_id IS NULL
         OR (m.created_at, m.id) > (c.last_read_at, c.last_read_message_id)
       )`,
    [currentUserId, peerId]
  )

  return result.rows[0]?.unread_count ?? 0
}

/**
 * 推进当前用户在某个会话中的最后已读位置。
 *
 * 事务内先取与消息发送相同的用户对级锁，再校验消息属于该会话、读取数据库中的真实
 * created_at，并只在 (created_at, id) 向前时写入；重复提交或更旧的位置不会让已读
 * 位置倒退，也不会改变 version。返回写入后的位置与该会话当前未读数。
 * 自我聊天允许推进，但未读始终为 0，不引入好友关系要求。
 */
export async function markConversationRead(
  currentUserId: string,
  peerId: string,
  lastReadMessageId: string
): Promise<ConversationReadState> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await lockUserPair(client, currentUserId, peerId)

    const conversation = await client.query(
      'SELECT 1 FROM user_conversations WHERE user_id = $1 AND peer_id = $2',
      [currentUserId, peerId]
    )

    if (conversation.rowCount === 0) {
      throw new ConversationNotFoundError()
    }

    const message = await client.query<MessagePositionRow>(
      'SELECT id, sender_id, receiver_id FROM messages WHERE id = $1',
      [lastReadMessageId]
    )

    if (message.rowCount === 0) {
      throw new ConversationMessageNotFoundError()
    }

    const row = message.rows[0]
    const belongsToConversation =
      (String(row.sender_id) === currentUserId && String(row.receiver_id) === peerId) ||
      (String(row.sender_id) === peerId && String(row.receiver_id) === currentUserId)

    if (!belongsToConversation) {
      throw new ConversationMessageNotFoundError()
    }

    // created_at 直接在 SQL 内从 messages 取值，避免 JS Date 只保留毫秒而截断微秒，
    // 导致与其同毫秒的消息被错误地算作“更晚”。
    const advanced = await client.query<{
      last_read_at: Date | string | null
      last_read_message_id: string | null
    }>(
      `UPDATE user_conversations AS c
       SET last_read_at = m.created_at,
           last_read_message_id = m.id,
           version = c.version + 1,
           updated_at = clock_timestamp()
       FROM messages AS m
       WHERE m.id = $3::bigint
         AND c.user_id = $1
         AND c.peer_id = $2
         AND (
           c.last_read_at IS NULL
           OR c.last_read_message_id IS NULL
           OR (m.created_at, m.id) > (c.last_read_at, c.last_read_message_id)
         )
       RETURNING c.last_read_at, c.last_read_message_id`,
      [currentUserId, peerId, lastReadMessageId]
    )

    let position = advanced.rows[0]

    if (advanced.rowCount === 0) {
      const current = await client.query<{
        last_read_at: Date | string | null
        last_read_message_id: string | null
      }>(
        `SELECT last_read_at, last_read_message_id
         FROM user_conversations
         WHERE user_id = $1 AND peer_id = $2`,
        [currentUserId, peerId]
      )
      position = current.rows[0]
    }

    const unreadCount = await countUnreadMessages(client, currentUserId, peerId)

    await client.query('COMMIT')

    return {
      lastReadAt: toIso(position.last_read_at),
      lastReadMessageId:
        position.last_read_message_id === null ? null : String(position.last_read_message_id),
      unreadCount
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
