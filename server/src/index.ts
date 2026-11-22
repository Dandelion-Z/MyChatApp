import { createServer } from 'node:http'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { Server } from 'socket.io'
import { pool } from './database/pool'
import { authRouter } from './routes/authRoutes'
import { friendRouter } from './routes/friendRoutes'
import { messageRouter } from './routes/messageRoutes'
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

const app = express()

// 不信任任何代理转发头（X-Forwarded-For 等）：这些头可由客户端伪造。
// 限流同样只使用 TCP 对端地址，避免伪造头绕过限流。
// 将来部署在可信反向代理后面时，需要显式配置 trust proxy 并相应调整限流取址。
app.set('trust proxy', false)

// REST API 的 CORS：只允许配置的来源，不使用通配符
app.use(
  cors({
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
)

app.use(express.json())

// 健康检查接口：只用于确认服务存活，不涉及数据库
app.get('/health', (_request, response) => {
  response.json({ status: 'ok' })
})

app.use('/api/auth', authRouter)
app.use('/api/friends', friendRouter)
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

  httpServer.listen(PORT, () => {
    console.log('MyChatApp 服务器已启动')
    console.log(`  监听端口：${PORT}`)
    console.log(`  健康检查：http://localhost:${PORT}/health`)
    console.log('  Socket.IO：已绑定到同一个 HTTP Server')
    console.log(`  CORS origins：${CORS_ORIGINS.join(', ')}`)
  })
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
