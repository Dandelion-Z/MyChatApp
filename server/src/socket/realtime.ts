import type { Server, Socket } from 'socket.io'

/**
 * 实时推送的公共出口。
 *
 * 在线连接表原先只存在于 socket/index.ts，只有消息与在线状态事件用得到；
 * 好友申请通过这类由 HTTP 接口触发的事件同样需要向指定用户推送，
 * 因此把「Socket.IO 实例 + 用户在线连接表 + 安全推送」集中到本模块。
 *
 * 规则：
 * - 连接表只由 Socket 生命周期维护（连接时写入、断开时按 socketId 复核后删除）；
 * - 推送失败只记录日志，绝不抛出：此时数据库事务已提交，实时通知失败不能影响业务结果，
 *   客户端会在下一次列表刷新或重连时自行补齐状态。
 */

let io: Server | null = null

/** 第一版规则：同一账号只保留最新一条连接（userId → socketId） */
const onlineUsers = new Map<string, string>()

/** 由 registerSocketHandlers 在注册处理器时注入 */
export function attachRealtimeServer(server: Server): void {
  io = server
}

export function setOnlineSocket(userId: string, socketId: string): void {
  onlineUsers.set(userId, socketId)
}

/**
 * 注销在线连接：只有当前映射仍是自己的 socketId 时才删除，
 * 避免旧连接的延迟断开把新连接的状态清掉。
 */
export function clearOnlineSocket(userId: string, socketId: string): void {
  if (onlineUsers.get(userId) === socketId) {
    onlineUsers.delete(userId)
  }
}

export function getOnlineSocketId(userId: string): string | undefined {
  return onlineUsers.get(userId)
}

export function getOnlineSocket(userId: string): Socket | undefined {
  const socketId = onlineUsers.get(userId)

  if (!socketId || !io) {
    return undefined
  }

  return io.sockets.sockets.get(socketId)
}

export function isUserOnline(userId: string): boolean {
  return onlineUsers.has(userId)
}

/**
 * 向指定用户当前连接推送事件。
 *
 * @returns 是否真的推送出去（离线或推送异常时为 false，调用方可按需记录）
 */
export function emitToUser(userId: string, event: string, payload: unknown): boolean {
  const socket = getOnlineSocket(userId)

  if (!socket || !socket.connected) {
    return false
  }

  try {
    socket.emit(event, payload)
    return true
  } catch (error) {
    console.error(
      `[realtime] 推送 ${event} 失败：`,
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}
