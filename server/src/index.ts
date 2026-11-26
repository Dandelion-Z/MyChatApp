import { createServer } from 'node:http'
import { isIP } from 'node:net'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { Server } from 'socket.io'
import { pool } from './database/pool'
import { authRouter } from './routes/authRoutes'
import { conversationRouter } from './routes/conversationRoutes'
import { friendRouter } from './routes/friendRoutes'
import { messageRouter } from './routes/messageRoutes'
import { profileRouter } from './routes/profileRoutes'
import { AVATAR_DIR } from './services/avatarService'
import { deleteExpiredMessages } from './services/messageService'
import { registerSocketHandlers } from './socket'

dotenv.config()

function readPort(): number {
  const rawPort = process.env.PORT?.trim()

  if (!rawPort) {
    return 3000
  }

  const port = Number(rawPort)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 不是合法端口：${rawPort}`)
  }

  return port
}

const PORT = readPort()

// Node 默认只监听本机回环地址，由同机 Nginx 反代对外提供 HTTPS。
// 生产部署保持默认 127.0.0.1；如确需其他地址（容器联调等），显式设置 HOST。
function readHost(): string {
  const rawHost = process.env.HOST?.trim()

  if (!rawHost) {
    return '127.0.0.1'
  }

  if (/\s|\//.test(rawHost)) {
    throw new Error(`HOST 不是合法的主机地址：${rawHost}`)
  }

  if (rawHost === '0.0.0.0' || rawHost === '::') {
    console.warn('警告：HOST 监听所有网络接口，业务端口会直接暴露；生产环境应使用 127.0.0.1。')
  }

  return rawHost
}

const HOST = readHost()

// 允许的来源：开发环境 Vite 页面 + Electron 自定义协议页面。
// 不包含通配符与 null，避免任意网页或 file:// 页面调用后端。
const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'app://mychatapp']

function readCorsOrigins(): string[] {
  const rawOrigins = process.env.CORS_ORIGIN?.trim()

  if (!rawOrigins) {
    return DEFAULT_CORS_ORIGINS
  }

  const origins = rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  if (origins.length === 0) {
    return DEFAULT_CORS_ORIGINS
  }

  for (const origin of origins) {
    if (origin === '*') {
      throw new Error('CORS_ORIGIN 不允许使用通配符 *')
    }

    if (origin === 'null') {
      throw new Error('CORS_ORIGIN 不允许使用 null')
    }

    try {
      new URL(origin)
    } catch {
      throw new Error(`CORS_ORIGIN 不是合法来源：${origin}`)
    }
  }

  return origins
}

const CORS_ORIGINS = readCorsOrigins()

function isValidProxyEntry(entry: string): boolean {
  const ipVersion = isIP(entry)

  if (ipVersion !== 0) {
    return true
  }

  const [address, prefix, ...rest] = entry.split('/')

  if (rest.length > 0 || !address || !prefix) {
    return false
  }

  const addressVersion = isIP(address)

  if (addressVersion === 0 || !/^\d{1,3}$/.test(prefix)) {
    return false
  }

  const maxPrefix = addressVersion === 6 ? 128 : 32
  const prefixNumber = Number(prefix)

  return prefixNumber >= 0 && prefixNumber <= maxPrefix
}

/**
 * 可信反向代理地址。
 *
 * 默认 false：不信任任何转发头，限流使用 TCP 对端地址。
 * 部署 SPA/Nginx 时通过 TRUST_PROXY 显式列出 Nginx 的地址（如 127.0.0.1），
 * 不要使用 true 或固定跳数，否则客户端可以伪造 X-Forwarded-For 绕过限流。
 */
function readTrustProxy(): false | string[] {
  const raw = process.env.TRUST_PROXY?.trim()

  if (!raw) {
    return false
  }

  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (entries.length === 0) {
    return false
  }

  for (const entry of entries) {
    if (!isValidProxyEntry(entry)) {
      throw new Error(`TRUST_PROXY 包含非法地址：${entry}`)
    }
  }

  return entries
}

const TRUST_PROXY = readTrustProxy()

const app = express()

// 必须在使用 req.ip 的中间件与路由注册之前设置。
app.set('trust proxy', TRUST_PROXY)

// REST API 的 CORS：只允许配置的来源，不使用通配符
app.use(
  cors({
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
)

app.use(express.json())

// 头像静态资源：文件名由服务端生成（随机 UUID），不做目录列表，可长期缓存。
// 头像本身不是私密内容，<img> 标签无法携带 Authorization，因此不额外做鉴权。
app.use(
  '/uploads/avatars',
  express.static(AVATAR_DIR, {
    index: false,
    dotfiles: 'deny',
    maxAge: '365d',
    immutable: true,
    fallthrough: true
  })
)

// 健康检查接口：只用于确认服务存活，不涉及数据库
app.get('/health', (_request, response) => {
  response.json({ status: 'ok' })
})

app.use('/api/auth', authRouter)
app.use('/api/friends', friendRouter)
app.use('/api/conversations', conversationRouter)
app.use('/api/profile', profileRouter)
app.use('/api/messages', messageRouter)

// Express 应用挂到 Node 原生 HTTP Server 上
const httpServer = createServer(app)

// Socket.IO 绑定到同一个 HTTP Server，不另外创建 HTTP 服务
const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGINS
  },
  // WebSocket 握手不受浏览器 CORS 约束，这里按同一份白名单显式校验 Origin。
  // 没有 Origin 的请求来自非浏览器客户端（如测试脚本），交给 JWT 鉴权处理。
  allowRequest: (request, callback) => {
    const origin = request.headers.origin

    if (!origin || CORS_ORIGINS.includes(origin)) {
      callback(null, true)
      return
    }

    callback('Origin not allowed', false)
  }
})

registerSocketHandlers(io)

// 消息保留策略：每小时清理一次超过保留期的消息；启动时先清理一次
const RETENTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
let retentionTimer: NodeJS.Timeout | null = null

async function runRetentionCleanup(): Promise<void> {
  try {
    const deleted = await deleteExpiredMessages()

    if (deleted > 0) {
      console.log(`[messages] 已清理 ${deleted} 条超过保留期的消息`)
    }
  } catch (error) {
    console.error(
      '[messages] 清理过期消息失败：',
      error instanceof Error ? error.message : String(error)
    )
  }
}

function startMessageRetention(): void {
  void runRetentionCleanup()

  retentionTimer = setInterval(() => {
    void runRetentionCleanup()
  }, RETENTION_CLEANUP_INTERVAL_MS)
}

httpServer.on('error', (error: NodeJS.ErrnoException) => {
  console.error('HTTP 服务器错误：', error.message)
  process.exit(1)
})

async function start(): Promise<void> {
  try {
    await pool.query('SELECT 1')
    console.log('数据库连接验证成功')
  } catch (error) {
    console.error(
      '数据库连接验证失败，服务器未启动：',
      error instanceof Error ? error.message : String(error)
    )

    try {
      await pool.end()
    } catch (endError) {
      console.error(
        '释放数据库连接池失败：',
        endError instanceof Error ? endError.message : String(endError)
      )
    }

    process.exitCode = 1
    return
  }

  httpServer.listen(PORT, HOST, () => {
    console.log('MyChatApp 服务器已启动')
    console.log(`  监听地址：http://${HOST}:${PORT}`)
    console.log(
      TRUST_PROXY === false
        ? '  可信代理：未配置（TRUST_PROXY 为空，忽略 X-Forwarded-For）'
        : `  可信代理：${TRUST_PROXY.join(', ')}`
    )
    console.log(`  健康检查：http://${HOST}:${PORT}/health`)
    console.log('  Socket.IO：已绑定到同一个 HTTP Server')
    console.log(`  CORS origins：${CORS_ORIGINS.join(', ')}`)
  })

  startMessageRetention()
}

void start()

let isShuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    console.error(`再次收到 ${signal}，强制退出`)
    process.exit(1)
  }

  isShuttingDown = true
  console.log(`\n收到 ${signal}，正在关闭服务器...`)

  if (retentionTimer) {
    clearInterval(retentionTimer)
    retentionTimer = null
  }

  // 保留 5 秒兜底；不使用 unref()，确保关闭流程不会无限等待
  const timeoutId = setTimeout(() => {
    console.error('关闭超时（5 秒），强制退出')
    process.exit(1)
  }, 5000)

  let hasError = false

  // 1) 先关闭 Socket.IO（它会同时关闭底层 HTTP Server）
  try {
    let closeError: Error | undefined = undefined

    await io.close((error) => {
      closeError = error
    })

    if (closeError) {
      throw closeError
    }

    console.log('Socket.IO 与 HTTP 服务器已关闭')
  } catch (error) {
    hasError = true
    console.error(
      '关闭 Socket.IO / HTTP 服务器失败：',
      error instanceof Error ? error.message : String(error)
    )
  }

  // 2) 无论上一步是否成功，都继续释放数据库连接池
  try {
    await pool.end()
    console.log('数据库连接池已关闭')
  } catch (error) {
    hasError = true
    console.error('关闭数据库连接池失败：', error instanceof Error ? error.message : String(error))
  }

  clearTimeout(timeoutId)

  if (hasError) {
    console.error('关闭过程中发生错误，进程以非零状态退出')
    process.exit(1)
  }

  console.log('Socket.IO、HTTP 服务器与数据库连接池已关闭，进程退出')
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})

process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
