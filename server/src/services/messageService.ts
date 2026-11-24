import type { PoolClient } from 'pg'
import { pool } from '../database/pool'
import { lockUserPair } from './userPairLock'

const ID_PATTERN = /^[1-9]\d*$/
const MAX_BIGINT = 9223372036854775807n
const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const CURSOR_ENCODED_PATTERN = /^[A-Za-z0-9_-]{1,512}$/

/**
 * 微秒精度的时间文本。
 *
 * 数据库按 (created_at, id) 排序，created_at 是 timestamptz（微秒精度），
 * 而 JS Date 只有毫秒。客户端若只拿到毫秒时间，同毫秒内的消息顺序只能退回按 id 排，
 * 但 id 是序列在 INSERT 时分配的，created_at 是事务开始时间，并发事务下两者顺序可能相反。
 * 因此消息 DTO 也返回同样的微秒文本，客户端按它排序才能与数据库一致。
 */
const CREATED_AT_PRECISE_SQL = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/**
 * 服务端消息保留天数。
 *
 * 服务端只保留最近 N 天的消息，更早的消息由清理任务删除；查询同样按该边界过滤，
 * 保证客户端在两次清理之间也不会拿到超出保留期的消息。
 * 默认 30 天，允许通过环境变量覆盖（测试用）。
 */
const DEFAULT_RETENTION_DAYS = 30
const RETENTION_ENV = 'MESSAGE_RETENTION_DAYS'

function retentionDays(): number {
  const raw = process.env[RETENTION_ENV]?.trim()

  if (!raw) {
    return DEFAULT_RETENTION_DAYS
  }

  const days = Number(raw)

  if (!Number.isInteger(days) || days < 1) {
    return DEFAULT_RETENTION_DAYS
  }

  return days
}

/** 保留期起点；早于该时间的消息视为过期 */
function retentionCutoff(): Date {
  return new Date(Date.now() - retentionDays() * 24 * 60 * 60 * 1000)
}

export type MessageItem = {
  id: string
  messageId: string
  senderId: string
  receiverId: string
  content: string
  createdAt: string
}

export type MessageHistoryPage = {
  messages: MessageItem[]
  hasMore: boolean
  nextCursor: string | null
}

type MessageCursor = {
  createdAt: string
  id: string
}

type MessageRow = {
  id: string | number
  message_id: string
  sender_id: string | number
  receiver_id: string | number
  content: string
  created_at: Date | string
  /** 微秒精度 ISO 文本；带该列时优先用它生成 createdAt */
  created_at_precise?: string
}

type HistoryRow = MessageRow & {
  created_at_precise: string
}

export type SendMessageResult = {
  message: MessageItem
  created: boolean
}

export class MessageUserNotFoundError extends Error {
  constructor() {
    super('用户不存在')
    this.name = 'MessageUserNotFoundError'
  }
}

export class InvalidMessageCursorError extends Error {
  constructor() {
    super('分页游标无效')
    this.name = 'InvalidMessageCursorError'
  }
}

export class MessageNotFriendError extends Error {
  constructor() {
    super('你们已经不是好友，无法发送消息')
    this.name = 'MessageNotFriendError'
  }
}

export class MessageIdConflictError extends Error {
  constructor() {
    super('messageId 已被其他消息使用')
    this.name = 'MessageIdConflictError'
  }
}

function toMessageItem(row: MessageRow): MessageItem {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    senderId: String(row.sender_id),
    receiverId: String(row.receiver_id),
    content: String(row.content),
    createdAt: row.created_at_precise ?? new Date(row.created_at).toISOString()
  }
}

function isPositiveBigInt(value: string): boolean {
  return ID_PATTERN.test(value) && value.length <= 19 && BigInt(value) <= MAX_BIGINT
}

/** 解析不透明游标；任何格式问题都抛出 400 类错误，绝不拼接进 SQL */
export function decodeMessageCursor(raw: string): MessageCursor {
  if (!CURSOR_ENCODED_PATTERN.test(raw)) {
    throw new InvalidMessageCursorError()
  }

  let decoded: unknown

  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidMessageCursorError()
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new InvalidMessageCursorError()
  }

  const { t, i } = decoded as { t?: unknown; i?: unknown }

  if (
    typeof t !== 'string' ||
    !CURSOR_TIME_PATTERN.test(t) ||
    typeof i !== 'string' ||
    !isPositiveBigInt(i)
  ) {
    throw new InvalidMessageCursorError()
  }

  return { createdAt: t, id: i }
}

function encodeMessageCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt, i: id }), 'utf8').toString('base64url')
}

function isInvalidDatetimeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }

  const code = (error as { code?: unknown }).code
  return code === '22007' || code === '22008'
}

async function findMessageByMessageId(messageId: string): Promise<MessageItem | null> {
  const result = await pool.query<MessageRow>(
    `SELECT id, message_id, sender_id, receiver_id, content, created_at,
            ${CREATED_AT_PRECISE_SQL} AS created_at_precise
     FROM messages
     WHERE message_id = $1`,
    [messageId]
  )

  const row = result.rows[0]
  return row ? toMessageItem(row) : null
}

function validateExistingMessage(
  existing: MessageItem,
  senderId: string,
  receiverId: string,
  content: string
): MessageItem {
  if (
    existing.senderId !== senderId ||
    existing.receiverId !== receiverId ||
    existing.content !== content
  ) {
    throw new MessageIdConflictError()
  }

  return existing
}

/**
 * 新消息写入后维护双方会话记录（自我聊天只维护一条）。
 *
 * 只更新消息活动字段与隐藏位，不改置顶、免打扰、已读位置和 version；
 * 与消息插入处于同一事务，保证原子性。
 */
async function maintainConversations(client: PoolClient, message: MessageRow): Promise<void> {
  const senderId = String(message.sender_id)
  const receiverId = String(message.receiver_id)
  const peers: Array<[string, string]> =
    senderId === receiverId
      ? [[senderId, receiverId]]
      : [
          [senderId, receiverId],
          [receiverId, senderId]
        ]

  for (const [userId, peerId] of peers) {
    await client.query(
      `INSERT INTO user_conversations (
         user_id, peer_id, last_message_at, last_message_id, last_activity_at,
         is_hidden, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $3, FALSE, clock_timestamp(), clock_timestamp())
       ON CONFLICT (user_id, peer_id) DO UPDATE
       SET last_message_at = EXCLUDED.last_message_at,
           last_message_id = EXCLUDED.last_message_id,
           last_activity_at = EXCLUDED.last_activity_at,
           is_hidden = FALSE,
           updated_at = clock_timestamp()`,
      [userId, peerId, message.created_at, message.id]
    )
  }
}

/**
 * 发送消息（幂等）。
 *
 * 顺序原则：
 * 1. 已存在相同 messageId 时先按原消息校验并返回，不再检查好友关系；
 * 2. 新消息才校验接收者与双向好友关系；
 * 3. 好友关系行在事务中 FOR SHARE，避免与删除好友并发时绕过检查；
 * 4. 依赖 message_id UNIQUE 处理并发重复，冲突后重新查询并按原消息校验。
 */
export async function sendMessage(
  senderId: string,
  receiverId: string,
  messageId: string,
  content: string
): Promise<SendMessageResult> {
  const existing = await findMessageByMessageId(messageId)

  if (existing) {
    return {
      message: validateExistingMessage(existing, senderId, receiverId, content),
      created: false
    }
  }

  const receiver = await pool.query('SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE', [
    receiverId
  ])

  if (receiver.rowCount === 0) {
    throw new MessageUserNotFoundError()
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = await pool.connect()
    let transactionOpen = false

    try {
      await client.query('BEGIN')
      transactionOpen = true

      // 同一对用户串行化：保证在锁内取数据库时钟、按 (created_at, id) 有序落库，
      // 并与删除好友互斥，删除完成后不会再有新消息写入
      await lockUserPair(client, senderId, receiverId)

      // 自我消息（接收方就是发送者）是个人备忘录，不需要好友关系；
      // 其余情况双向关系必须都存在；FOR SHARE 阻止删除好友事务在发送完成前提交
      if (senderId !== receiverId) {
        const friendship = await client.query<{ user_id: string }>(
          `SELECT user_id
           FROM friendships
           WHERE (user_id = $1 AND friend_id = $2)
              OR (user_id = $2 AND friend_id = $1)
           FOR SHARE`,
          [senderId, receiverId]
        )

        if ((friendship.rowCount ?? 0) < 2) {
          await client.query('ROLLBACK')
          transactionOpen = false

          // 并发情况下同一 messageId 可能刚被成功写入，此时重试语义优先
          const raced = await findMessageByMessageId(messageId)

          if (raced) {
            return {
              message: validateExistingMessage(raced, senderId, receiverId, content),
              created: false
            }
          }

          throw new MessageNotFriendError()
        }
      }

      const inserted = await client.query<MessageRow>(
        // 显式使用 clock_timestamp()：CURRENT_TIMESTAMP 是事务开始时间，
        // 并发发送时会早于实际取得锁的顺序，导致 (created_at, id) 排序错乱
        `INSERT INTO messages (message_id, sender_id, receiver_id, content, created_at)
         VALUES ($1, $2, $3, $4, clock_timestamp())
         ON CONFLICT (message_id) DO NOTHING
         RETURNING id, message_id, sender_id, receiver_id, content, created_at,
                   ${CREATED_AT_PRECISE_SQL} AS created_at_precise`,
        [messageId, senderId, receiverId, content]
      )

      if (inserted.rowCount === 1) {
        // 消息与双方会话记录在同一事务内完成，绝不出现“消息已保存、会话未更新”
        await maintainConversations(client, inserted.rows[0])

        await client.query('COMMIT')
        transactionOpen = false
        return { message: toMessageItem(inserted.rows[0]), created: true }
      }

      // 唯一约束冲突：回滚后读取已存在消息，按幂等规则处理
      await client.query('ROLLBACK')
      transactionOpen = false

      const raced = await findMessageByMessageId(messageId)

      if (raced) {
        return {
          message: validateExistingMessage(raced, senderId, receiverId, content),
          created: false
        }
      }
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // 连接已断开时忽略回滚失败，保留原始错误
        }
      }

      throw error
    } finally {
      client.release()
    }
  }

  throw new Error('消息并发写入冲突，请稍后重试')
}

export async function getMessageHistory(
  currentUserId: string,
  friendId: string,
  limit: number,
  before?: string
): Promise<MessageHistoryPage> {
  // 对方账号不存在或已注销时返回 404；不要求当前仍是好友
  const userResult = await pool.query('SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE', [
    friendId
  ])

  if (userResult.rowCount === 0) {
    throw new MessageUserNotFoundError()
  }

  const cursor = before ? decodeMessageCursor(before) : null
  const values: Array<string | number | Date> = [currentUserId, friendId, retentionCutoff()]
  let cursorClause = ''

  if (cursor) {
    // created_at 使用服务端生成的微秒精度文本，id 作为同一时间的第二排序键
    values.push(cursor.createdAt, cursor.id)
    cursorClause = 'AND (created_at, id) < ($4::timestamptz, $5::bigint)'
  }

  values.push(limit + 1)
  const limitParameter = `$${values.length}`

  try {
    const result = await pool.query<HistoryRow>(
      `SELECT
         id,
         message_id,
         sender_id,
         receiver_id,
         content,
         created_at,
         ${CREATED_AT_PRECISE_SQL} AS created_at_precise
       FROM messages
       WHERE (
               (sender_id = $1 AND receiver_id = $2)
            OR (sender_id = $2 AND receiver_id = $1)
             )
         ${cursorClause}
         AND created_at >= $3::timestamptz
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitParameter}`,
      values
    )

    const hasMore = result.rows.length > limit
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows
    const oldestRow = pageRows[pageRows.length - 1]
    const nextCursor =
      hasMore && oldestRow
        ? encodeMessageCursor(oldestRow.created_at_precise, String(oldestRow.id))
        : null

    // 数据库按时间倒序取页，返回前反转为升序，便于聊天界面直接渲染
    const messages = [...pageRows].reverse().map(toMessageItem)

    return { messages, hasMore, nextCursor }
  } catch (error) {
    if (isInvalidDatetimeError(error)) {
      throw new InvalidMessageCursorError()
    }

    throw error
  }
}

/**
 * 增量同步：按 (created_at, id) 升序返回游标之后的消息。
 *
 * 与历史查询（从新到旧）互补，用于客户端把本地缺失的消息按时间顺序补齐：
 * 1. 只返回保留期内的消息，与清理任务保持同一时间边界；
 * 2. 游标为 null 时从保留期最早一条开始（首次同步）；
 * 3. nextCursor 始终指向本页最后一条消息，便于客户端逐页推进并在中断后继续。
 */
export async function getMessagesAfter(
  currentUserId: string,
  friendId: string,
  limit: number,
  after?: string
): Promise<MessageHistoryPage> {
  const userResult = await pool.query('SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE', [
    friendId
  ])

  if (userResult.rowCount === 0) {
    throw new MessageUserNotFoundError()
  }

  const cursor = after ? decodeMessageCursor(after) : null
  const values: Array<string | number | Date> = [currentUserId, friendId, retentionCutoff()]
  let cursorClause = ''

  if (cursor) {
    values.push(cursor.createdAt, cursor.id)
    cursorClause = 'AND (created_at, id) > ($4::timestamptz, $5::bigint)'
  }

  values.push(limit + 1)
  const limitParameter = `$${values.length}`

  try {
    const result = await pool.query<HistoryRow>(
      `SELECT
         id,
         message_id,
         sender_id,
         receiver_id,
         content,
         created_at,
         ${CREATED_AT_PRECISE_SQL} AS created_at_precise
       FROM messages
       WHERE (
               (sender_id = $1 AND receiver_id = $2)
            OR (sender_id = $2 AND receiver_id = $1)
             )
         ${cursorClause}
         AND created_at >= $3::timestamptz
       ORDER BY created_at ASC, id ASC
       LIMIT ${limitParameter}`,
      values
    )

    const hasMore = result.rows.length > limit
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows
    const lastRow = pageRows[pageRows.length - 1]
    const nextCursor = lastRow
      ? encodeMessageCursor(lastRow.created_at_precise, String(lastRow.id))
      : null

    return { messages: pageRows.map(toMessageItem), hasMore, nextCursor }
  } catch (error) {
    if (isInvalidDatetimeError(error)) {
      throw new InvalidMessageCursorError()
    }

    throw error
  }
}

/**
 * 删除超过保留期的消息。
 *
 * 只影响服务端存储：客户端已经同步到本地的记录不受影响，
 * 清理后客户端也不会再通过增量同步重新下载这些消息（游标只会前进）。
 */
export async function deleteExpiredMessages(): Promise<number> {
  const result = await pool.query('DELETE FROM messages WHERE created_at < $1::timestamptz', [
    retentionCutoff()
  ])

  return result.rowCount ?? 0
}
