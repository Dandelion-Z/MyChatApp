import { useState } from 'react'
import type { FormEvent } from 'react'
import { register } from '../api/auth'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'

type Mode = 'login' | 'register'

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return '无法连接服务器，请确认后端服务已启动后重试。'
    }

    if (error.status === 500) {
      return '服务器内部错误，请稍后重试。'
    }

    return error.message
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return '操作失败，请稍后重试。'
}

function AuthScreen(): React.JSX.Element {
  const { login, notice } = useAuth()

  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState<string>('')
  const [password, setPassword] = useState<string>('')
  const [nickname, setNickname] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<boolean>(false)
  // 默认不勾选自动登录；仅影响 Refresh Token 是否持久化
  const [autoLogin, setAutoLogin] = useState<boolean>(false)

  const switchMode = (nextMode: Mode): void => {
    setMode(nextMode)
    setError(null)
    setSuccess(null)
    setPassword('')
    setNickname('')
  }

  const handleLogin = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    if (submitting) {
      return
    }

    setError(null)
    setSuccess(null)
    setSubmitting(true)

    try {
      // 成功后由 App 根据认证状态自动切换到聊天界面
      await login(username.trim(), password, autoLogin)
    } catch (loginError) {
      setError(getErrorMessage(loginError))
    } finally {
      setSubmitting(false)
    }
  }

  const handleRegister = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    if (submitting) {
      return
    }

    setError(null)
    setSuccess(null)
    setSubmitting(true)

    const normalizedUsername = username.trim().toLowerCase()

    try {
      await register({
        username: normalizedUsername,
        password,
        nickname: nickname.trim()
      })

      setMode('login')
      setUsername(normalizedUsername)
      setPassword('')
      setNickname('')
      setSuccess('注册成功，请使用新账号登录。')
    } catch (registerError) {
      setError(getErrorMessage(registerError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-brand">MyChatApp</h1>
        <p className="auth-subtitle">{mode === 'login' ? '登录以继续聊天' : '创建一个新账号'}</p>

        {notice && <p className="auth-notice">{notice}</p>}

        {success && mode === 'login' && <p className="auth-success">{success}</p>}

        {mode === 'login' ? (
          <form className="auth-form" onSubmit={handleLogin}>
            <label className="auth-field">
              用户名
              <input
                className="auth-input"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
                disabled={submitting}
              />
            </label>

            <label className="auth-field">
              密码
              <input
                className="auth-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                disabled={submitting}
              />
            </label>

            <label className="auth-checkbox">
              <input
                type="checkbox"
                checked={autoLogin}
                onChange={(event) => setAutoLogin(event.target.checked)}
                disabled={submitting}
              />
              <span>自动登录（30 天内免密码）</span>
            </label>

            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}

            <button className="auth-submit" type="submit" disabled={submitting}>
              {submitting ? '登录中…' : '登录'}
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={handleRegister}>
            <label className="auth-field">
              用户名
              <input
                className="auth-input"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
                disabled={submitting}
              />
            </label>

            <label className="auth-field">
              密码
              <input
                className="auth-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
                disabled={submitting}
              />
            </label>

            <label className="auth-field">
              昵称
              <input
                className="auth-input"
                type="text"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                autoComplete="nickname"
                required
                disabled={submitting}
              />
            </label>

            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}

            <button className="auth-submit" type="submit" disabled={submitting}>
              {submitting ? '注册中…' : '注册账号'}
            </button>
          </form>
        )}

        <p className="auth-switch">
          {mode === 'login' ? (
            <>
              还没有账号？
              <button className="auth-link" type="button" onClick={() => switchMode('register')}>
                注册账号
              </button>
            </>
          ) : (
            <>
              已有账号？
              <button className="auth-link" type="button" onClick={() => switchMode('login')}>
                返回登录
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}

export default AuthScreen
