import type { JwtPayload } from 'jsonwebtoken'
import { verify } from 'jsonwebtoken'
import type { Server } from 'socket.io'
import { pool } from '../database/pool'
import { getJwtSecret } from '../services/authService'
import { registerMessageHandler } from './messageHandler'
import {
  attachRealtimeServer,
  clearOnlineSocket,
  getOnlineSocket,
  getOnlineSocketId,
  isUserOnline,
  setOnlineSocket
} from './realtime'

const USER_ID_PATTERN = /^[1-9]\d*$/

type SocketData = {
  userId?: string
  tokenExp?: number
}

export function registerSocketHandlers(io: Server): void {
  // 把 Socket.IO 实例交给实时推送模块：HTTP 接口（如同意好友申请）也要向在线用户推送事件
  attachRealtimeServer(io)

  // 握手认证：身份只来自 JWT，绝不信任客户端提交的 userId
  io.use(async (socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown } | undefined
    const token = auth?.token

    if (typeof token !== 'string' || token.trim().length === 0) {
      next(new Error('unauthorized'))
      return
    }

    let payload: string | JwtPayload

    try {
      payload = verify(token, getJwtSecret(), { algorithms: ['HS256'] })
    } catch {
      next(new Error('unauthorized'))
      return
    }

    if (
      typeof payload === 'string' ||
      typeof payload.sub !== 'string' ||
      !USER_ID_PATTERN.test(payload.sub)
    ) {
      next(new Error('unauthorized'))
      return
    }

    try {
      // 用户必须存在且未被软删除
      const result = await pool.query('SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE', [
        payload.sub
      ])

      if (result.rowCount === 0) {
        next(new Error('unauthorized'))
        return
      }
    } catch {
      next(new Error('unauthorized'))
      return
    }

    const data = socket.data as SocketData
    data.userId = payload.sub
    data.tokenExp = typeof payload.exp === 'number' ? payload.exp : undefined

    next()
  })

  io.on('connection', (socket) => {
    const data = socket.data as SocketData
    const userId = data.userId
    const tokenExp = data.tokenExp

    if (!userId) {
      socket.disconnect(true)
      return
    }

    console.log(`Socket.IO 已连接：socket=${socket.id} userId=${userId}`)

    // 同一账号新连接替换旧连接：先写入新 socketId，再断开旧连接
    const previousSocketId = getOnlineSocketId(userId)
    setOnlineSocket(userId, socket.id)

    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId)

      if (previousSocket) {
        // 先告知旧客户端「被其他登录替换」，留出事件发送时间后再断开，
        // 这样客户端能区分被踢下线与网络断开/服务端重启
        previousSocket.emit('session:replaced')
        setTimeout(() => previousSocket.disconnect(true), 100)
      }
    }

    // Token 到期后服务端主动断开，避免过期连接继续使用
    const expiryTimer =
      tokenExp !== undefined
        ? setTimeout(
            () => {
              console.log(`Socket.IO Token 已过期，断开：socket=${socket.id} userId=${userId}`)
              socket.disconnect(true)
            },
            Math.max(0, tokenExp * 1000 - Date.now())
          )
        : null

    socket.on('presence:get', async () => {
      try {
        // 只根据认证用户 ID 查询其好友范围内的在线用户
        const result = await pool.query('SELECT friend_id FROM friendships WHERE user_id = $1', [
          userId
        ])

        const onlineFriendIds = result.rows
          .map((row) => String(row.friend_id))
          .filter((friendId) => isUserOnline(friendId))

        socket.emit('presence:snapshot', { onlineFriendIds })
      } catch (error) {
        console.error('查询在线好友失败：', error instanceof Error ? error.message : String(error))
        socket.emit('presence:snapshot', { onlineFriendIds: [] })
      }
    })

    // 消息发送：身份只使用当前 socket 的认证 userId
    registerMessageHandler(socket, userId, (receiverId) => getOnlineSocket(receiverId))

    socket.on('disconnect', (reason) => {
      if (expiryTimer !== null) {
        clearTimeout(expiryTimer)
      }

      // 只有当前映射中的 socketId 仍属于自己时才删除，避免旧连接的延迟断开删除新连接状态
      clearOnlineSocket(userId, socket.id)

      console.log(`Socket.IO 已断开：socket=${socket.id} userId=${userId} reason=${reason}`)
    })
  })
}
