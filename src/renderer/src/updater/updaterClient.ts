import type { UpdaterState } from '../../../shared/updater'

/**
 * 自动更新由主进程管理，渲染端只读状态；
 * 启动门禁依赖轮询而不是事件订阅，保持 preload 只暴露 invoke 接口。
 */
export function getUpdaterState(): Promise<UpdaterState> {
  return window.api.updater.getState()
}

export function retryUpdateCheck(): Promise<UpdaterState> {
  return window.api.updater.retry()
}
