import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { login as loginRequest, refreshSession, revokeSession } from '../api/auth'
import type { AuthUser, LoginResult } from '../api/auth'
import { ApiError, request } from '../api/client'
import type { RequestOptions } from '../api/client'
import { refreshSocketAuth, subscribeSocketStatus } from '../socket/socketClient'
import {
  addCredentialTombstone,
  clearCredential,
  loadSavedCredentials,
  saveCredential
} from './secureStore'
import type { SavedCredential } from './secureStore'
import { clearSession, getSession, saveSession } from './session'
import type { Session } from './session'

// Access Token 到期前 60 秒主动刷新，避免请求撞在过期边界上
const REFRESH_LEAD_MS = 60_000
// 发请求前 5 秒视为「即将过期」，先刷新再发
const REQUEST_LEAD_MS = 5_000
// 浏览器 setTimeout 的最大可表示延迟（约 24.8 天）
const MAX_TIMER_DELAY_MS = 2_147_483_647
// 网络暂时不可用时的刷新重试间隔（服务恢复后即可继续，不立即登出）
const NETWORK_RETRY_DELAY_MS = 10_000

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

export type AuthContextValue = {
  status: AuthStatus
  user: AuthUser | null
  /** 被其他登录替换等需要展示在登录页的提示 */
  notice: string | null
  login: (username: string, password: string, autoLogin: boolean) => Promise<void>
  logout: () => void
  requestWithAuth: <T>(path: string, options?: RequestOptions) => Promise<T>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const tokenRef = useRef<string | null>(null)
  const expiresAtRef = useRef<number | null>(null)
  const refreshTokenRef = useRef<string | null>(null)
  const refreshExpiresAtRef = useRef<number | null>(null)
  const autoLoginRef = useRef<boolean>(false)
  const userIdRef = useRef<string | null>(null)
  const userRef = useRef<AuthUser | null>(null)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 同一时间只允许一个刷新请求；并发调用复用同一个 Promise
  const refreshPromiseRef = useRef<Promise<string> | null>(null)
  // 每次登录 / 登出递增，用于丢弃迟到的异步结果
  const authEpochRef = useRef(0)
  const restoreStartedRef = useRef(false)
  // 由下面的 refreshAccessToken 赋值，供定时器调用，避免 useCallback 之间循环依赖
  const refreshRef = useRef<() => Promise<string>>(async () => {
    throw new ApiError(401, '登录已过期，请重新登录')
  })

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const logout = useCallback((): void => {
    const refreshToken = refreshTokenRef.current
    const userId = userIdRef.current
    const refreshExpiresAt = refreshExpiresAtRef.current

    authEpochRef.current += 1
    tokenRef.current = null
    expiresAtRef.current = null
    refreshTokenRef.current = null
    refreshExpiresAtRef.current = null
    autoLoginRef.current = false
    userIdRef.current = null
    userRef.current = null
    clearTimer()
    clearSession()
    setUser(null)
    setStatus('unauthenticated')

    // 服务端撤销与本地安全存储清理都是尽力而为，不阻塞界面登出；
    // 但必须先落墓碑：即使撤销失败、凭证文件暂时无法解密，
    // 之后恢复可读时也会过滤掉这个 Token，不会重新自动登录
    if (refreshToken) {
      const tombstone =
        userId !== null
          ? addCredentialTombstone(userId, refreshToken, refreshExpiresAt ?? undefined)
          : Promise.resolve(false)

      void tombstone
        .catch(() => false)
        .then(() => {
          void revokeSession(refreshToken).catch(() => {})

          if (userId !== null) {
            // 只清除本次会话自己的凭证，双开同账号时不能删掉新实例保存的 Token
            void clearCredential(userId, refreshToken)
          }
        })
      return
    }

    if (userId !== null) {
      void clearCredential(userId)
    }
  }, [clearTimer])

  const scheduleRefresh = useCallback(
    (expiresAt: number): void => {
      clearTimer()

      const runAt = (target: number): void => {
        const delay = Math.max(
          0,
          Math.min(target - Date.now() - REFRESH_LEAD_MS, MAX_TIMER_DELAY_MS)
        )

        timerRef.current = setTimeout(() => {
          if (Date.now() < target - REFRESH_LEAD_MS) {
            // setTimeout 上限导致的提前触发：继续等待剩余时间
            runAt(target)
            return
          }

          void refreshRef.current().catch(() => {})
        }, delay)
      }

      runAt(expiresAt)
    },
    [clearTimer]
  )

  const scheduleNetworkRetry = useCallback((): void => {
    clearTimer()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void refreshRef.current().catch(() => {})
    }, NETWORK_RETRY_DELAY_MS)
  }, [clearTimer])

  /** 把一次登录/刷新返回的凭证应用到内存、sessionStorage 与刷新定时器 */
  const applyAuthData = useCallback(
    (data: LoginResult, autoLogin: boolean): void => {
      const expiresAt = Date.now() + data.expiresIn * 1000

      tokenRef.current = data.accessToken
      expiresAtRef.current = expiresAt
      refreshTokenRef.current = data.refreshToken
      refreshExpiresAtRef.current = Date.now() + data.refreshExpiresIn * 1000
      autoLoginRef.current = autoLogin
      userIdRef.current = data.user.id
      userRef.current = data.user

      saveSession({ accessToken: data.accessToken, user: data.user, expiresAt })
      setUser(data.user)
      setStatus('authenticated')
      scheduleRefresh(expiresAt)
    },
    [scheduleRefresh]
  )

  const restoreFromSession = useCallback(
    (session: Session): void => {
      tokenRef.current = session.accessToken
      expiresAtRef.current = session.expiresAt
      refreshTokenRef.current = null
      refreshExpiresAtRef.current = null
      autoLoginRef.current = false
      userIdRef.current = session.user.id
      userRef.current = session.user
      setUser(session.user)
      setStatus('authenticated')
      scheduleRefresh(session.expiresAt)
    },
    [scheduleRefresh]
  )

  const refreshAccessToken = useCallback(async (): Promise<string> => {
    const existing = refreshPromiseRef.current

    if (existing) {
      return existing
    }

    const refreshToken = refreshTokenRef.current

    if (!refreshToken) {
      logout()
      throw new ApiError(401, '登录已过期，请重新登录')
    }

    const epoch = authEpochRef.current

    const promise = (async (): Promise<string> => {
      try {
        const response = await refreshSession(refreshToken)
        const data = response.data

        // 刷新期间发生了登出或新的登录：丢弃这次结果
        if (epoch !== authEpochRef.current) {
          throw new ApiError(401, '登录状态已变更')
        }

        applyAuthData(data, data.autoLogin)

        if (data.autoLogin) {
          void saveCredential({
            userId: data.user.id,
            refreshToken: data.refreshToken,
            expiresAt: refreshExpiresAtRef.current ?? Date.now()
          })
        }

        // 服务端在旧 Token 到期时会断开 Socket；这里主动用新 Token 重建连接
        refreshSocketAuth()

        return data.accessToken
      } catch (error) {
        if (epoch !== authEpochRef.current) {
          throw error
        }

        if (error instanceof ApiError && error.status === 401) {
          // Refresh Token 过期 / 已被撤销 / 被判定重放：清除失效凭证
          const userId = userIdRef.current

          if (userId) {
            // 先落墓碑再清理：清理可能因文件暂时不可解密而跳过
            void addCredentialTombstone(userId, refreshToken)
              .catch(() => false)
              .then(() => clearCredential(userId, refreshToken))
          }

          logout()
          throw error
        }

        if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
          // 网络或服务端暂时不可用：Access Token 还没过期就稍后重试
          const expiresAt = expiresAtRef.current

          if (expiresAt !== null && Date.now() < expiresAt - REQUEST_LEAD_MS) {
            scheduleNetworkRetry()
          } else {
            logout()
          }

          throw error
        }

        logout()
        throw error
      } finally {
        refreshPromiseRef.current = null
      }
    })()

    refreshPromiseRef.current = promise

    return promise
  }, [applyAuthData, logout, scheduleNetworkRetry])

  useEffect(() => {
    refreshRef.current = refreshAccessToken
  }, [refreshAccessToken])

  // 启动时恢复登录：prioritize 安全存储中的长期凭证，其次 sessionStorage
  useEffect(() => {
    if (restoreStartedRef.current) {
      return
    }

    restoreStartedRef.current = true

    const run = async (): Promise<void> => {
      const epoch = authEpochRef.current
      const session = getSession()
      const stored = await loadSavedCredentials()

      let saved: SavedCredential | null = null

      if (stored) {
        if (session) {
          saved =
            stored.credentials.find((credential) => credential.userId === session.user.id) ?? null
        } else {
          saved =
            stored.credentials.find((credential) => credential.userId === stored.activeUserId) ??
            null
        }
      }

      if (saved) {
        refreshTokenRef.current = saved.refreshToken
        refreshExpiresAtRef.current = saved.expiresAt
        autoLoginRef.current = true
        userIdRef.current = saved.userId

        try {
          await refreshAccessToken()
          return
        } catch {
          if (epoch !== authEpochRef.current) {
            return
          }

          // 网络问题时保留仍然有效的本地 Access Token，避免直接掉回登录页
          if (session && session.expiresAt > Date.now()) {
            restoreFromSession(session)
            return
          }

          setStatus('unauthenticated')
          return
        }
      }

      if (session) {
        restoreFromSession(session)
        return
      }

      setStatus('unauthenticated')
    }

    void run()
  }, [refreshAccessToken, restoreFromSession])

  const login = useCallback(
    async (username: string, password: string, autoLogin: boolean): Promise<void> => {
      const epoch = ++authEpochRef.current
      const response = await loginRequest({ username, password, autoLogin })

      if (epoch !== authEpochRef.current) {
        return
      }

      const data = response.data

      const stored = await loadSavedCredentials()
      const previous = stored?.credentials.find((credential) => credential.userId === data.user.id)

      if (autoLogin) {
        const failure = await saveCredential({
          userId: data.user.id,
          refreshToken: data.refreshToken,
          expiresAt: Date.now() + data.refreshExpiresIn * 1000
        })

        if (failure) {
          // 无法安全保存时不进入已登录状态，也不留下可用的长期凭证
          void revokeSession(data.refreshToken).catch(() => {})
          throw new Error('当前系统无法安全保存自动登录凭证，请取消勾选后重试。')
        }
      } else {
        // 未勾选自动登录：清理该账号遗留的持久化凭证
        await clearCredential(data.user.id)
      }

      if (previous && previous.refreshToken !== data.refreshToken) {
        void revokeSession(previous.refreshToken).catch(() => {})
      }

      if (epoch !== authEpochRef.current) {
        return
      }

      setNotice(null)
      applyAuthData(data, autoLogin)
    },
    [applyAuthData]
  )

  const requestWithAuth = useCallback(
    async <T,>(path: string, options: RequestOptions = {}): Promise<T> => {
      let token = tokenRef.current
      const expiresAt = expiresAtRef.current

      if (!token || expiresAt === null || Date.now() >= expiresAt - REQUEST_LEAD_MS) {
        token = await refreshAccessToken()
      }

      try {
        return await request<T>(path, { ...options, token })
      } catch (error) {
        // Access Token 被服务端判定失效（例如时钟偏差）：刷新后只重试一次
        if (error instanceof ApiError && error.status === 401) {
          const freshToken = await refreshAccessToken()
          return await request<T>(path, { ...options, token: freshToken })
        }

        throw error
      }
    },
    [refreshAccessToken]
  )

  // 同一账号在其他位置登录：服务端会先发 session:replaced 再断开旧连接
  useEffect(() => {
    const unsubscribe = subscribeSocketStatus((nextStatus) => {
      if (nextStatus === 'replaced') {
        setNotice('该账号已在其他位置登录，当前设备已退出。')
        logout()
      }
    })

    return unsubscribe
  }, [logout])

  // 电脑休眠 / 窗口切回时，如果已接近过期就立即刷新
  useEffect(() => {
    const handleFocus = (): void => {
      const expiresAt = expiresAtRef.current

      if (expiresAt !== null && Date.now() >= expiresAt - REFRESH_LEAD_MS) {
        void refreshAccessToken().catch(() => {})
      }
    }

    window.addEventListener('focus', handleFocus)

    return () => {
      window.removeEventListener('focus', handleFocus)
    }
  }, [refreshAccessToken])

  useEffect(() => {
    return () => {
      clearTimer()
    }
  }, [clearTimer])

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, notice, login, logout, requestWithAuth }),
    [status, user, notice, login, logout, requestWithAuth]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth 必须在 AuthProvider 内部使用')
  }

  return context
}
