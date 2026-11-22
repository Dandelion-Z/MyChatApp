import { join } from 'node:path'
import dotenv from 'dotenv'
import { Pool } from 'pg'

// 在创建连接池之前加载 server/.env。
// 显式指定路径，避免依赖启动时的工作目录（src 与 dist 下相对位置一致）。
dotenv.config({ path: join(__dirname, '..', '..', '.env'), quiet: true })

const connectionString = process.env.DATABASE_URL?.trim()

if (!connectionString) {
  throw new Error(
    '未配置 DATABASE_URL：请在 server/.env 中设置数据库连接字符串（可参考 server/.env.example）。'
  )
}

// 全后端共享的 PostgreSQL 连接池
export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
})

// 空闲连接出错时（例如数据库重启、网络中断），记录错误但不让进程崩溃
pool.on('error', (error: Error) => {
  console.error('数据库连接池空闲连接错误：', error.message)
})
