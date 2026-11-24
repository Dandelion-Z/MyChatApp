import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdaterState } from '../../shared/updater'
import { useAuth } from './auth/AuthContext'
import AuthScreen from './components/AuthScreen'
import ChatScreen from './components/ChatScreen'
import UpdateGate from './components/UpdateGate'
import { syncLocalMessages } from './localMessages/sync'
import { getUpdaterState, retryUpdateCheck } from './updater/updaterClient'

const FALLBACK_STATE: UpdaterState = { phase: 'checking', message: '正在检查更新…' }
const POLL_INTERVAL_MS = 800

function App(): React.JSX.Element {
  const { status, user, requestWithAuth } = useAuth()
  const [updaterState, setUpdaterState] = useState<UpdaterState | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  // 每个登录会话只启动一次增量同步，避免状态刷新导致重复拉取
  const syncedUserIdRef = useRef<string | null>(null)

  // 门禁状态由主进程持有，渲染端轮询直到检查完成
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const poll = async (): Promise<void> => {
      try {
        const next = await getUpdaterState()

        if (cancelled) {
          return
        }

        setUpdaterState(next)

        if (next.phase !== 'ready') {
          timer = window.setTimeout(poll, POLL_INTERVAL_MS)
        }
      } catch {
        if (cancelled) {
          return
        }

        setUpdaterState({ phase: 'error', message: '无法获取更新状态，请重试。' })
      }
    }

    void poll()

    return () => {
      cancelled = true

      if (timer !== undefined) {
        window.clearTimeout(timer)
      }
    }
  }, [retryToken])

  // 登录成功后按本地同步进度补拉服务端保留期内的历史消息（不改变聊天界面）
  useEffect(() => {
    if (status !== 'authenticated' || !user) {
      syncedUserIdRef.current = null
      return
    }

    if (syncedUserIdRef.current === user.id) {
      return
    }

    syncedUserIdRef.current = user.id
    const controller = new AbortController()

    void syncLocalMessages(requestWithAuth, user.id, controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        console.warn('[localSync] 本地消息同步失败，下次登录继续', error)
      }
    })

    return () => controller.abort()
  }, [status, user, requestWithAuth])

  const handleRetry = useCallback(async (): Promise<void> => {
    setRetrying(true)

    try {
      await retryUpdateCheck()
    } catch {
      // 主进程不可用时由轮询重新报错
    }

    setRetrying(false)
    setRetryToken((token) => token + 1)
  }, [])

  let content: React.JSX.Element

  if (updaterState?.phase !== 'ready') {
    content = (
      <UpdateGate
        state={updaterState ?? FALLBACK_STATE}
        retrying={retrying}
        onRetry={handleRetry}
      />
    )
  } else if (status === 'loading') {
    content = (
      <div className="app-loading">
        <p>正在加载…</p>
      </div>
    )
  } else {
    content = status === 'authenticated' ? <ChatScreen /> : <AuthScreen />
  }

  // 自绘标题栏：隐藏系统标题栏后，这条 40px 拖拽带负责拖动与双击最大化，
  // 右侧留给系统绘制的窗口按钮（见主进程 titleBarOverlay）。
  return (
    <div className="window">
      <div className="window-titlebar" />
      <div className="window-body">{content}</div>
    </div>
  )
}

export default App
