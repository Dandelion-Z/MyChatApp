import type { PoolClient } from 'pg'

/**
 * 同一对用户之间的会话级串行化锁。
 *
 * 消息发送与删除好友都必须先取得这把锁，保证：
 * 1. 同一会话内的消息按取得锁的先后写入，created_at 由数据库时钟在锁内生成；
 * 2. 删除好友不会与并发的消息写入交错，删除完成后不会再有新消息或会话记录冒出来。
 *
 * 键由两个用户 ID 按数值升序拼接后哈希成 64 位整数，同一对用户（含自我聊天）得到同一把锁，
 * 不同用户对互不阻塞，不使用全局锁。锁随事务结束自动释放。
 */
export async function lockUserPair(
  client: PoolClient,
  firstUserId: string,
  secondUserId: string
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(
         LEAST($1::bigint, $2::bigint)::text || ':' || GREATEST($1::bigint, $2::bigint)::text,
         0
       )
     )`,
    [firstUserId, secondUserId]
  )
}
