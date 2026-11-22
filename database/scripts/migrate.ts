import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import type { ClientConfig } from 'pg'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

// 迁移文件命名规则：0001_xxx.sql（至少 4 位数字 + 下划线 + 小写字母/数字/下划线）
const MIGRATION_FILE_PATTERN = /^\d{4,}_[a-z0-9_]+\.sql$/

// 第一版只允许把这个初始迁移登记为基线
const BASELINE_VERSION = '0001_initial_schema.sql'

const CREATE_SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`

function printUsage(): void {
  console.log(
    [
      '用法：',
      '  tsx database/scripts/migrate.ts migrate',
      '      执行 database/migrations 下所有尚未执行的迁移',
      '',
      '  tsx database/scripts/migrate.ts baseline 0001_initial_schema.sql',
      '      仅把 0001 登记为已执行（不执行 SQL、不校验结构）',
      '',
      '对应的 npm 脚本：',
      '  npm run db:migrate',
      '  npm run db:baseline -- 0001_initial_schema.sql'
    ].join('\n')
  )
}

function readClientConfig(): ClientConfig {
  const connectionString = process.env.DATABASE_URL?.trim()

  if (connectionString) {
    return { connectionString }
  }

  const database = process.env.PGDATABASE?.trim()

  if (!database) {
    throw new Error(
      '未找到数据库连接配置：请设置 DATABASE_URL，或至少设置 PGDATABASE（可配合 PGHOST、PGPORT、PGUSER、PGPASSWORD）。'
    )
  }

  const portText = process.env.PGPORT?.trim()
  const port = portText ? Number(portText) : undefined

  if (port !== undefined && Number.isNaN(port)) {
    throw new Error(`PGPORT 不是合法端口：${portText}`)
  }

  return {
    database,
    host: process.env.PGHOST?.trim() || undefined,
    port,
    user: process.env.PGUSER?.trim() || undefined,
    password: process.env.PGPASSWORD
  }
}

function listMigrationFiles(): string[] {
  const sqlFiles = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)

  const invalidFiles = sqlFiles.filter((file) => !MIGRATION_FILE_PATTERN.test(file))

  if (invalidFiles.length > 0) {
    throw new Error(
      `以下迁移文件名不符合规则（应为 0001_描述.sql，只允许小写字母、数字、下划线）：${invalidFiles.join('、')}`
    )
  }

  sqlFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  return sqlFiles
}

async function ensureSchemaMigrations(client: Client): Promise<void> {
  await client.query(CREATE_SCHEMA_MIGRATIONS_SQL)
}

async function getAppliedVersions(client: Client): Promise<Set<string>> {
  const result = await client.query('SELECT version FROM schema_migrations')

  return new Set(result.rows.map((row) => String(row.version)))
}

async function applyMigration(client: Client, version: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS_DIR, version), 'utf8')

  await client.query('BEGIN')

  try {
    await client.query(sql)
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
    await client.query('COMMIT')
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // ROLLBACK 失败（例如连接已断开）时忽略，保留最初导致迁移失败的错误
    }
    throw error
  }
}

async function registerBaseline(client: Client, version: string): Promise<void> {
  const result = await client.query(
    'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
    [version]
  )

  if (result.rowCount === 1) {
    console.log(`已登记基线：${version}`)
  } else {
    console.log(`基线已存在，未重复登记：${version}`)
  }
}

async function runPendingMigrations(client: Client, migrationFiles: string[]): Promise<void> {
  const appliedVersions = await getAppliedVersions(client)
  const pending = migrationFiles.filter((file) => !appliedVersions.has(file))
  const skipped = migrationFiles.length - pending.length

  console.log(
    `迁移检查完成：共 ${migrationFiles.length} 个文件，已执行 ${skipped} 个，待执行 ${pending.length} 个。`
  )

  if (pending.length === 0) {
    console.log('没有需要执行的迁移。')
    return
  }

  for (const version of pending) {
    process.stdout.write(`执行 ${version} ... `)
    try {
      await applyMigration(client, version)
      console.log('成功')
    } catch (error) {
      console.log('失败')
      throw error
    }
  }

  console.log(`本次共执行 ${pending.length} 个迁移，全部完成。`)
}

async function main(): Promise<void> {
  const command = process.argv[2]

  if (command !== 'migrate' && command !== 'baseline') {
    printUsage()
    process.exitCode = 1
    return
  }

  const migrationFiles = listMigrationFiles()

  if (command === 'baseline') {
    const requestedVersion = process.argv[3]

    if (!requestedVersion) {
      console.error('基线登记必须明确指定迁移文件名，例如：')
      console.error('  npm run db:baseline -- 0001_initial_schema.sql')
      process.exitCode = 1
      return
    }

    if (requestedVersion !== BASELINE_VERSION) {
      console.error(`第一版基线登记只允许使用 ${BASELINE_VERSION}，收到：${requestedVersion}`)
      process.exitCode = 1
      return
    }

    if (!migrationFiles.includes(BASELINE_VERSION)) {
      console.error(`找不到迁移文件：${BASELINE_VERSION}`)
      process.exitCode = 1
      return
    }
  }

  const client = new Client(readClientConfig())
  let hasPrimaryError = false

  try {
    await client.connect()
    await ensureSchemaMigrations(client)

    if (command === 'baseline') {
      console.log('基线登记模式：不会执行任何 SQL，也不会校验数据库结构。')
      await registerBaseline(client, BASELINE_VERSION)
      return
    }

    await runPendingMigrations(client, migrationFiles)
  } catch (error) {
    hasPrimaryError = true
    throw error
  } finally {
    try {
      await client.end()
    } catch (endError) {
      // 连接释放失败时，只在没有更重要的主错误的情况下报告
      if (!hasPrimaryError) {
        const message = endError instanceof Error ? endError.message : String(endError)
        console.error('关闭数据库连接失败：', message)
        process.exitCode = 1
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error('迁移失败：', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
