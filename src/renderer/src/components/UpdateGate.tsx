import type { UpdaterState } from '../../../shared/updater'

interface UpdateGateProps {
  state: UpdaterState
  retrying: boolean
  onRetry: () => void
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.min(100, Math.max(0, value))
}

/**
 * 启动更新门禁：检查/下载/安装完成前不渲染登录界面。
 * 失败时保留重试入口，符合「检查失败禁止进入登录界面」的要求。
 */
function UpdateGate({ state, retrying, onRetry }: UpdateGateProps): React.JSX.Element {
  const busy = state.phase === 'checking' || state.phase === 'downloading'

  return (
    <div className="update-gate">
      <div className="update-card">
        <div className="update-brand">永夜</div>
        <p className={`update-message update-${state.phase}`} role="status">
          {state.message}
        </p>

        {state.phase === 'downloading' && state.progress ? (
          <div
            className="update-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clampPercent(state.progress.percent))}
          >
            <div
              className="update-progress-bar"
              style={{ width: `${clampPercent(state.progress.percent)}%` }}
            />
          </div>
        ) : null}

        {state.phase === 'error' ? (
          <button className="auth-submit update-retry" onClick={onRetry} disabled={retrying}>
            {retrying ? '正在重试…' : '重试'}
          </button>
        ) : null}

        {busy ? <p className="update-hint">更新检查完成前无法进入登录界面。</p> : null}
        {state.phase === 'installing' ? (
          <p className="update-hint">应用即将自动重启，请勿关闭窗口。</p>
        ) : null}
      </div>
    </div>
  )
}

export default UpdateGate
