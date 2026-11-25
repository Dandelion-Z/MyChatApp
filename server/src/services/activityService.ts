import { pool } from '../database/pool'

/**
 * 每日活跃积分：同一 UTC 自然日内，密码登录或自动登录（刷新令牌）只加 1 点。
 *
 * 单条 UPDATE 内比较 last_login_at 的 UTC 日期，借助行锁保证并发请求
 * （多次登录 / 多次刷新 / 登录与刷新同时发生）只会有一笔真正加分。
 * 调用方必须确保认证凭证已经验证成功，失败请求不得调用本方法。
 */
export async function recordDailyLoginActivity(userId: string): Promise<void> {
  await pool.query(
    `UPDATE users
     SET activity_points = activity_points + CASE
           WHEN last_login_at IS NULL
             OR (last_login_at AT TIME ZONE 'UTC')::date
                <> (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
           THEN 1 ELSE 0 END,
         last_login_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [userId]
  )
}
