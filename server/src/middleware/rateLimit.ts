import type { Request, RequestHandler } from 'express'

/**
 * 极简的内存 IP 限流：单进程固定窗口计数。
 *
 * 选择内存实现是因为服务端目前只有单个实例、没有 Redis；
 * 重启后计数清零属于可接受行为。若将来多实例部署，需要换成共享存储。
 */

type Bucket = {
  count: number
  resetAt: number
}

type RateLimitOptions = {
  /** 窗口内允许的最大请求数 */
  limit: number
  /** 窗口长度，毫秒 */
  windowMs: number
  /** 用于区分接口的键前缀 */
  name: string
}

const buckets = new Map<string, Bucket>()
// 上限保护：异常流量下避免 Map 无限增长
const MAX_BUCKETS = 10_000

function sweepExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key)
    }
  }
}

/**
 * 只使用 TCP 连接的对端地址，不读取 X-Forwarded-For。
 * 该头可以随便伪造，直接采信会让攻击者通过更换头绕过限流。
 *
 * 因此本服务默认不信任任何代理；如果将来部署在反向代理后面，
 * 需要在受控环境中开启 trust proxy，并让限流改为读取 req.ip。
 */
function clientKey(request: Request): string {
  const address = request.socket.remoteAddress ?? 'unknown'

  // IPv4-mapped IPv6 统一成 IPv4，避免同一来源被拆成两个桶
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const { limit, windowMs, name } = options

  return (request, response, next) => {
    const now = Date.now()

    if (buckets.size > MAX_BUCKETS) {
      sweepExpired(now)
    }

    const key = `${name}:${clientKey(request)}`
    let bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
    }

    bucket.count += 1

    const remaining = Math.max(0, limit - bucket.count)
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))

    response.setHeader('RateLimit-Limit', String(limit))
    response.setHeader('RateLimit-Remaining', String(remaining))
    response.setHeader('RateLimit-Reset', String(resetSeconds))

    if (bucket.count > limit) {
      response.setHeader('Retry-After', String(resetSeconds))
      response.status(429).json({
        success: false,
        error: '请求过于频繁，请稍后再试'
      })
      return
    }

    next()
  }
}

// 注册：每小时 5 次，抑制批量注册
export const registerRateLimit = createRateLimit({
  name: 'auth:register',
  windowMs: 60 * 60 * 1000,
  limit: 5
})

// 登录：15 分钟 10 次，抑制密码暴力破解
export const loginRateLimit = createRateLimit({
  name: 'auth:login',
  windowMs: 15 * 60 * 1000,
  limit: 10
})

// Refresh：15 分钟 30 次；正常客户端每 15 分钟才刷新一次，余量充足
export const refreshRateLimit = createRateLimit({
  name: 'auth:refresh',
  windowMs: 15 * 60 * 1000,
  limit: 30
})
