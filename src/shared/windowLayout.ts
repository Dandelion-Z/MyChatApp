/**
 * 窗口布局模式：登录、注册使用紧凑窗口，聊天界面使用原有窗口尺寸。
 * 仅用于在三种界面之间切换窗口大小，不承载其他窗口行为。
 */
export type WindowLayoutMode = 'login' | 'register' | 'chat'

export type WindowLayoutApi = {
  set: (mode: WindowLayoutMode) => Promise<void>
}
