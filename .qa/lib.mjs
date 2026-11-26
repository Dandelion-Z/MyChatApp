import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const qaDir = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(qaDir, '..')
const SERVER_DIR = path.join(PROJECT_ROOT, 'server')

// 测试脚本复用服务端已安装的 jsonwebtoken，避免为了 QA 再装一份依赖
const require = createRequire(path.join(SERVER_DIR, 'package.json'))
export const jwt = require('jsonwebtoken')

export const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:3000'

function readSecret() {
  const fromEnv = process.env.QA_JWT_SECRET ?? process.env.JWT_SECRET

  if (fromEnv) {
    return fromEnv
  }

  // 单独运行某个脚本时的兜底：只读取，不修改 server/.env
  const envFile = path.join(SERVER_DIR, '.env')

  if (!existsSync(envFile)) {
    throw new Error('缺少 QA_JWT_SECRET，且未找到 server/.env')
  }

  const matched = readFileSync(envFile, 'utf8').match(/^JWT_SECRET=(.*)$/m)

  if (!matched || !matched[1].trim()) {
    throw new Error('server/.env 中缺少 JWT_SECRET')
  }

  return matched[1].trim()
}

export const JWT_SECRET = readSecret()

let pass = 0
let fail = 0
const failures = []

export function check(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log('PASS', name, detail === undefined ? '' : JSON.stringify(detail))
  } else {
    fail += 1
    failures.push(name)
    console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail))
  }
}

export function section(name) {
  console.log(`\n# ${name}`)
}

export function summary(title) {
  console.log(`\nSUMMARY ${title}: ${pass}/${pass + fail} passed`)
  if (failures.length > 0) {
    console.log('FAILED:', failures.join(' | '))
    process.exitCode = 1
  }
}

export async function api(method, path, options = {}) {
  const { token, body, headers = {}, raw } = options
  const init = { method, headers: { ...headers } }
  if (token) init.headers.Authorization = `Bearer ${token}`
  if (raw !== undefined) {
    init.body = raw
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(BASE + path, init)
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, json, text, headers: response.headers }
}

export const PASSWORD = 'QaTestPass123!'

export async function register(username, nickname = username) {
  return api('POST', '/api/auth/register', { body: { username, password: PASSWORD, nickname } })
}

export async function login(username, password = PASSWORD) {
  return api('POST', '/api/auth/login', { body: { username, password } })
}

export function bearer(token) {
  return { Authorization: `Bearer ${token}` }
}
