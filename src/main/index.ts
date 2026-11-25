import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  Tray,
  Menu,
  nativeImage
} from 'electron'
import { join, normalize, sep } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import windowsIcon from '../../resources/icon.ico?asset'
import { registerAuthStorage } from './authStorage'
import { registerLocalMessageStore } from './localMessageStore'
import { registerUpdater } from './updater'

// 生产环境页面使用自定义协议加载，避免 file:// 页面产生 null Origin。
// 协议名与 host 固定，渲染进程 Origin 为 app://mychatapp。
const RENDERER_SCHEME = 'app'
const RENDERER_HOST = 'mychatapp'
const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`

/**
 * 登录、注册与聊天三种界面各自的目标窗口尺寸（含系统边框与标题栏）。
 * 聊天沿用改造前的 900x670，登录/注册使用与内容贴合的紧凑尺寸。
 */
const WINDOW_LAYOUTS = {
  login: { width: 440, height: 480 },
  register: { width: 440, height: 560 },
  chat: { width: 900, height: 670 }
} as const

type WindowLayoutMode = keyof typeof WINDOW_LAYOUTS

function isWindowLayoutMode(value: unknown): value is WindowLayoutMode {
  return typeof value === 'string' && value in WINDOW_LAYOUTS
}

// 自绘标题栏高度：渲染端的拖拽条与此保持一致，窗口按钮由系统绘制在右上角
const TITLE_BAR_HEIGHT = 40
const TITLE_BAR_COLOR = '#f2f2f7'

// 主窗口唯一实例：关闭时只隐藏，真正退出由托盘菜单或系统退出触发
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

// 必须在 app ready 之前声明协议特权：
// standard: 拥有正常的 origin（否则仍是 opaque origin）
// secure: 视为安全上下文，且允许连接被视为可信的 http://localhost
// supportFetchAPI: 渲染进程可以正常 fetch app:// 资源
// corsEnabled: 按 CORS 规则发起跨源请求，并携带 Origin
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

/**
 * 注册 app:// 协议，把请求映射到打包后的 renderer 目录。
 * 只允许访问 renderer 根目录内的文件，拒绝目录穿越。
 */
function registerRendererProtocol(): void {
  const rendererRoot = normalize(join(__dirname, '../renderer'))

  protocol.handle(RENDERER_SCHEME, async (request) => {
    let url: URL

    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }

    if (url.host !== RENDERER_HOST) {
      return new Response('Not Found', { status: 404 })
    }

    let pathname: string

    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }

    const relativePath = pathname === '/' || pathname === '' ? 'index.html' : pathname
    const filePath = normalize(join(rendererRoot, relativePath))

    // 目录穿越防护：解析后的路径必须仍在 renderer 根目录内
    if (filePath !== rendererRoot && !filePath.startsWith(rendererRoot + sep)) {
      return new Response('Forbidden', { status: 403 })
    }

    try {
      // 交给 Electron 网络栈读取文件，自动带上正确的 Content-Type 与范围请求支持
      return await net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}

function createWindow(): BrowserWindow {
  // 窗口已存在时只恢复显示，避免重复创建导致托盘/隐藏状态混乱
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow()
    return mainWindow
  }

  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    // Windows 隐藏系统标题栏（不再显示应用图标与名称），只保留系统绘制的
    // 最小化 / 最大化 / 关闭按钮；窗口拖动由渲染端顶部拖拽条提供。
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: TITLE_BAR_COLOR,
            symbolColor: '#1d1d1f',
            height: TITLE_BAR_HEIGHT
          },
          // Windows 下不传 icon 时会回退到 electron.exe 自带的 Electron 图标，
          // 这里显式使用项目图标，保证开发版任务栏/Alt+Tab 也是永夜图标。
          icon: windowsIcon
        }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 用户回到窗口即停止任务栏闪烁，不需要渲染端额外配合
  mainWindow.on('focus', () => {
    mainWindow?.flashFrame(false)
  })

  // 关闭按钮只隐藏窗口，应用继续驻留托盘；QUIT 流程由托盘菜单置位
  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return
    }

    event.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the custom protocol for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadURL(`${RENDERER_ORIGIN}/index.html`)
  }

  return mainWindow
}

/** 从托盘恢复主窗口：不存在则重新创建，最小化则还原，然后聚焦到前台 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }

  mainWindow.show()
  mainWindow.focus()
}

/**
 * 系统托盘：单实例创建，图标复用打包资源。
 * 左键点击 / 双击恢复窗口，右键弹出菜单，只有「退出程序」会真正结束应用。
 */
function createTray(): void {
  if (tray) {
    return
  }

  const trayIcon = nativeImage.createFromPath(icon)

  tray = new Tray(trayIcon.isEmpty() ? icon : trayIcon.resize({ width: 16, height: 16 }))
  tray.setToolTip('永夜')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '退出程序',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  // 不调用 setContextMenu：Windows 上那会让左键也弹出菜单，
  // 这里保持左键恢复窗口、右键弹菜单的语义。
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
  tray.on('right-click', () => tray?.popUpContextMenu(contextMenu))
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows，必须与 electron-builder.yml 的 appId 一致，
  // 否则固定到任务栏/通知的图标可能回退到 Electron 默认图标
  electronApp.setAppUserModelId('com.electron.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 自定义协议必须在 app ready 之后注册
  registerRendererProtocol()

  // 自动登录凭证：由主进程使用 safeStorage 加密后写入 userData
  registerAuthStorage()

  // 本地聊天记录：SQLite 存放在 userData/data，按账号隔离并共享 1 GB 额度
  registerLocalMessageStore()

  // 自动更新门禁：正式版先检查更新，开发环境直接放行
  registerUpdater()

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // 登录 / 注册 / 聊天界面切换窗口尺寸，切换后重新居中
  ipcMain.handle('window:set-layout', (event, mode: unknown) => {
    if (!isWindowLayoutMode(mode)) {
      return
    }

    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window || window.isDestroyed()) {
      return
    }

    const { width, height } = WINDOW_LAYOUTS[mode]

    if (window.isFullScreen()) {
      return
    }

    if (window.isMaximized()) {
      window.unmaximize()
    }

    const [currentWidth, currentHeight] = window.getSize()

    if (currentWidth === width && currentHeight === height) {
      return
    }

    window.setSize(width, height, false)
    window.center()
  })

  // 任务栏闪烁提醒：只在窗口不在前台时开始；窗口重获焦点即停止
  ipcMain.handle('window:flash', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window || window.isDestroyed() || window.isFocused()) {
      return
    }

    window.flashFrame(true)
  })

  ipcMain.handle('window:flash-stop', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window || window.isDestroyed()) {
      return
    }

    window.flashFrame(false)
  })

  createWindow()
  createTray()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 任何来源的退出（托盘菜单、系统关机、自动更新）都要放行 close 拦截
app.on('before-quit', () => {
  isQuitting = true
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    return
  }

  // 关闭按钮已被拦截为隐藏窗口；走到这里说明窗口被真正销毁，
  // 只有明确的退出流程才顺带结束应用，否则保持托盘驻留。
  if (isQuitting) {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
