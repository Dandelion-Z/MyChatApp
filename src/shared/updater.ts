export type UpdaterPhase = 'checking' | 'downloading' | 'installing' | 'ready' | 'error'

export interface UpdaterProgress {
  percent: number
  transferred: number
  total: number
}

export interface UpdaterState {
  phase: UpdaterPhase
  /** 面向用户的说明文字（主进程生成，渲染端直接展示） */
  message: string
  /** 正在下载/下载完成的目标版本 */
  version?: string
  progress?: UpdaterProgress
}

export interface UpdaterApi {
  /** 读取当前更新状态；渲染端通过轮询驱动启动门禁 */
  getState: () => Promise<UpdaterState>
  /** 检查失败后重试（下载中/安装中/检查中调用会被忽略） */
  retry: () => Promise<UpdaterState>
}
