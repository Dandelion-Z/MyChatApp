import { app, shell, BrowserWindow, ipcMain, net, protocol } from 'electron'
import { join, normalize, sep } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerAuthStorage } from './authStorage'

// 生产环境页面使用自定义协议加载，避免 file:// 页面产生 null Origin。
// 协议名与 host 固定，渲染进程 Origin 为 app://mychatapp。
const RENDERER_SCHEME = 'app'
const RENDERER_HOST = 'mychatapp'
const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`

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

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

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

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
