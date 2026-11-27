#!/usr/bin/env node
/**
 * 本地假更新服务器（仅用于打包测试，不参与正式发布）。
 *
 * 修复点：electron-updater 请求 latest.yml 时会带 `?noCache=<ts>` 查询参数，
 * 因此这里用 URL.pathname 匹配，而不是对完整 req.url 做 endsWith/includes。
 *
 * 用法：
 *   node scripts/fake-update-server.mjs
 *   FAKE_UPDATE_PORT=3999 FAKE_UPDATE_VERSION=1.0.0 node scripts/fake-update-server.mjs
 *
 * 环境变量：
 *   FAKE_UPDATE_PORT     监听端口，默认 3999
 *   FAKE_UPDATE_VERSION  返回给客户端的版本号，默认取 package.json 的 version
 *   FAKE_UPDATE_PATH     feed 路径前缀，默认 /polarnight
 *   FAKE_UPDATE_DIR      可选的静态文件目录（例如 dist）。
 *                        目录内若存在 latest.yml 则原样返回，并同时提供其中列出的
 *                        安装包/blockmap 下载；不存在则按 FAKE_UPDATE_VERSION 动态生成。
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

const port = Number(process.env.FAKE_UPDATE_PORT ?? 3999)
const feedPath = `/${(process.env.FAKE_UPDATE_PATH ?? '/polarnight').replace(/^\/+|\/+$/g, '')}`
const serveDir = process.env.FAKE_UPDATE_DIR ? resolve(process.env.FAKE_UPDATE_DIR) : null
const configuredVersion = process.env.FAKE_UPDATE_VERSION ?? pkg.version

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[fake-update] 非法端口：${process.env.FAKE_UPDATE_PORT}`)
  process.exit(1)
}

const CONTENT_TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.zip': 'application/octet-stream',
  '.dmg': 'application/octet-stream',
  '.AppImage': 'application/octet-stream'
}

function readLatestYmlFromDir() {
  if (!serveDir) return null
  const candidate = join(serveDir, 'latest.yml')
  return existsSync(candidate) ? readFileSync(candidate, 'utf8') : null
}

/** 没有现成 latest.yml 时，生成一份最小可用的校验信息（同版本号 = 无更新）。 */
function buildGeneratedLatestYml(version) {
  const artifactName = `${pkg.name}-${version}-setup.exe`
  const artifact = serveDir ? join(serveDir, artifactName) : null
  const hasArtifact = artifact !== null && existsSync(artifact)

  const lines = [`version: ${version}`, "releaseDate: '2000-01-01T00:00:00.000Z'"]
  if (hasArtifact) {
    lines.push(
      'files:',
      `  - url: ${artifactName}`,
      `    size: ${statSync(artifact).size}`,
      '    sha512: ""'
    )
  } else {
    lines.push('files: []')
  }
  return `${lines.join('\n')}\n`
}

const latestYmlFromDir = readLatestYmlFromDir()
if (latestYmlFromDir && process.env.FAKE_UPDATE_VERSION) {
  console.warn(
    `[fake-update] FAKE_UPDATE_DIR 中存在 latest.yml，已忽略 FAKE_UPDATE_VERSION=${process.env.FAKE_UPDATE_VERSION}`
  )
}
const latestYml = latestYmlFromDir ?? buildGeneratedLatestYml(configuredVersion)
const reportedVersion = /^version:\s*(.+)$/m.exec(latestYml)?.[1]?.trim()

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
  response.end(body)
}

function resolveStaticFile(pathname) {
  if (!serveDir || !pathname.startsWith(`${feedPath}/`)) return null
  const relativePath = decodeURIComponent(pathname.slice(feedPath.length + 1))
  if (!relativePath) return null
  const normalized = normalize(join(serveDir, relativePath))
  if (normalized !== serveDir && !normalized.startsWith(`${serveDir}${sep}`)) return null
  if (!existsSync(normalized) || !statSync(normalized).isFile()) return null
  return normalized
}

const server = createServer((request, response) => {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  const pathname = decodeURIComponent(url.pathname)
  const query = url.search || ''

  if (method !== 'GET' && method !== 'HEAD') {
    console.warn(`[fake-update] ${method} ${pathname}${query} -> 405`)
    send(response, 405, 'method not allowed')
    return
  }

  // 关键：只看 pathname，忽略 ?noCache=... 之类的查询串
  if (pathname === `${feedPath}/latest.yml`) {
    const body = method === 'HEAD' ? '' : latestYml
    console.log(`[fake-update] ${method} ${pathname}${query} -> 200 (version=${reportedVersion})`)
    send(response, 200, body, { 'Content-Type': CONTENT_TYPES['.yml'] })
    return
  }

  const filePath = resolveStaticFile(pathname)
  if (filePath) {
    const body = method === 'HEAD' ? '' : readFileSync(filePath)
    console.log(`[fake-update] ${method} ${pathname}${query} -> 200 (file)`)
    send(response, 200, body, {
      'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': String(statSync(filePath).size)
    })
    return
  }

  console.warn(`[fake-update] ${method} ${pathname}${query} -> 404`)
  send(response, 404, 'not found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-update] listening on http://127.0.0.1:${port}${feedPath}`)
  console.log(`[fake-update] latest.yml version: ${reportedVersion}`)
  if (serveDir) console.log(`[fake-update] serving static files from: ${serveDir}`)
})

server.on('error', (error) => {
  console.error(`[fake-update] 启动失败：${error.message}`)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[fake-update] received ${signal}, shutting down`)
    server.close(() => process.exit(0))
  })
}
