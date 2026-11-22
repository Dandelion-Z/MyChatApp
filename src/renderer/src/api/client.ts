const DEFAULT_API_BASE_URL = 'http://localhost:3000'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type RequestOptions = {
  method?: HttpMethod
  body?: unknown
  headers?: Record<string, string>
  /** 预留的 Bearer Token 注入点；Token 的存储与刷新由后续认证模块负责 */
  token?: string | null
  signal?: AbortSignal
}

/** 统一的 API 错误：status 为 0 表示网络连接失败 */
export class ApiError extends Error {
  readonly status: number
  readonly details?: unknown

  constructor(status: number, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

// 从环境变量读取，未配置时使用本地开发默认地址；去掉末尾斜杠避免路径拼接出现双斜杠
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '')

function extractErrorMessage(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const value = (payload as { error?: unknown }).error

    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }

  return null
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null
  }

  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  return response.text()
}

/**
 * 通用 HTTP 请求封装。
 *
 * 返回值是后端原始 JSON 结构（不做 data/friends 等包装假设），
 * 由调用方通过泛型 T 指定具体响应类型。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers, token, signal } = options

  const url =
    path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers
  }

  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`
  }

  let response: Response

  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    })
  } catch (error) {
    // 网络层失败（服务未启动、断网、DNS 等），不泄露底层敏感信息
    throw new ApiError(0, '无法连接服务器，请确认后端服务已启动并检查网络连接。', error)
  }

  const payload = await parseResponseBody(response)

  if (!response.ok) {
    const message = extractErrorMessage(payload) ?? `请求失败（HTTP ${response.status}）`
    throw new ApiError(response.status, message, payload)
  }

  return payload as T
}
