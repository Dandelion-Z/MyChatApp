import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { pool } from '../database/pool'
import { ProfileNotFoundError } from './profileService'

/** 头像文件目录：默认 server/uploads/avatars，可用 AVATAR_DIR 指向持久化磁盘。 */
export const AVATAR_DIR =
  process.env.AVATAR_DIR?.trim() || path.resolve(__dirname, '../../uploads/avatars')

/** 上传原图上限（压缩前），与 multer、客户端的限制保持一致 */
export const MAX_AVATAR_UPLOAD_BYTES = 5 * 1024 * 1024

/** 头像图片最长边上限；只缩小不放大，宽高比例保持不变 */
const MAX_AVATAR_EDGE = 512
/** 头像图片最短边下限，宽或高任意一边小于该值即拒绝 */
const MIN_AVATAR_EDGE = 128
/** 允许的真实图片格式（以 sharp 解析结果为准，不看扩展名/MIME） */
const ALLOWED_AVATAR_FORMATS = new Set(['jpeg', 'png', 'webp'])

const AVATAR_URL_PREFIX = '/uploads/avatars/'
const AVATAR_URL_PATTERN = /^\/uploads\/avatars\/[a-z0-9-]+\.webp$/

/** 图片内容无法识别或转换失败（接口返回 400，而不是 500） */
export class InvalidAvatarImageError extends Error {
  constructor(message = '图片格式不支持或文件已损坏') {
    super(message)
    this.name = 'InvalidAvatarImageError'
  }
}

/** 实际格式不在 JPEG/PNG/WebP 白名单内 */
export class InvalidAvatarFormatError extends Error {
  constructor(message = '仅支持 JPG、PNG、WebP 格式的图片') {
    super(message)
    this.name = 'InvalidAvatarFormatError'
  }
}

/** 实际宽高不满足最短边要求 */
export class InvalidAvatarSizeError extends Error {
  constructor(message = '图片宽度和高度都不能小于 128px') {
    super(message)
    this.name = 'InvalidAvatarSizeError'
  }
}

async function ensureAvatarDir(): Promise<void> {
  await mkdir(AVATAR_DIR, { recursive: true })
}

/** 只允许删除本服务头像目录内、且符合命名规则的文件，避免路径穿越误删。 */
async function removeAvatarFile(avatarUrl: string | null): Promise<void> {
  if (!avatarUrl || !AVATAR_URL_PATTERN.test(avatarUrl)) {
    return
  }

  const filePath = path.join(AVATAR_DIR, path.basename(avatarUrl))

  try {
    await unlink(filePath)
  } catch (error) {
    // 文件已被删除或不可读不应影响接口主流程
    console.warn('[avatar] 删除旧头像失败：', error)
  }
}

/**
 * 校验并处理上传图片：
 * - 用 sharp 实际解析内容判断格式，只接受 JPEG/PNG/WebP；
 * - 读取真实宽高（EXIF 方向 5/6/7/8 需要交换宽高），宽高都不得小于 128px；
 * - rotate() 按 EXIF 方向纠正，fit: inside + withoutEnlargement 只缩小不放大，
 *   最长边不超过 512px，宽高比例保持不变；
 * - 统一转换为 WebP（质量沿用 82）。
 */
async function processAvatarImage(source: Buffer): Promise<Buffer> {
  const metadata = await sharp(source, { failOn: 'error' })
    .metadata()
    .catch(() => {
      throw new InvalidAvatarImageError()
    })

  if (!metadata.format || !ALLOWED_AVATAR_FORMATS.has(metadata.format)) {
    throw new InvalidAvatarFormatError()
  }

  const rawWidth = metadata.width ?? 0
  const rawHeight = metadata.height ?? 0
  // EXIF 5/6/7/8 表示旋转 90/270 度，展示时的宽高与原始像素宽高互换
  const swapped = metadata.orientation !== undefined && metadata.orientation >= 5
  const width = swapped ? rawHeight : rawWidth
  const height = swapped ? rawWidth : rawHeight

  if (width < MIN_AVATAR_EDGE || height < MIN_AVATAR_EDGE) {
    throw new InvalidAvatarSizeError()
  }

  try {
    return await sharp(source, { failOn: 'error' })
      .rotate()
      .resize({
        width: MAX_AVATAR_EDGE,
        height: MAX_AVATAR_EDGE,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer()
  } catch {
    throw new InvalidAvatarImageError()
  }
}

/**
 * 保存新头像：先落盘再更新数据库；数据库更新失败时删除刚落盘的文件。
 * 数据库中的旧头像文件在更新成功后尽力清理。
 */
export async function setUserAvatar(userId: string, source: Buffer): Promise<string> {
  const processed = await processAvatarImage(source)
  await ensureAvatarDir()

  const fileName = `${randomUUID()}.webp`
  const filePath = path.join(AVATAR_DIR, fileName)
  await writeFile(filePath, processed)

  const avatarUrl = `${AVATAR_URL_PREFIX}${fileName}`

  try {
    const result = await pool.query<{ previous: string | null }>(
      `WITH previous AS (
         SELECT avatar_url FROM users WHERE id = $1 AND is_deleted = FALSE FOR UPDATE
       )
       UPDATE users u
          SET avatar_url = $2
         FROM previous
        WHERE u.id = $1
        RETURNING previous.avatar_url AS previous`,
      [userId, avatarUrl]
    )

    if (result.rowCount === 0) {
      throw new ProfileNotFoundError()
    }

    await removeAvatarFile(result.rows[0].previous)
    return avatarUrl
  } catch (error) {
    await removeAvatarFile(avatarUrl)
    throw error
  }
}

/** 恢复默认头像：清空数据库字段并尽力删除旧文件。 */
export async function clearUserAvatar(userId: string): Promise<void> {
  const result = await pool.query<{ previous: string | null }>(
    `WITH previous AS (
       SELECT avatar_url FROM users WHERE id = $1 AND is_deleted = FALSE FOR UPDATE
     )
     UPDATE users u
        SET avatar_url = NULL
       FROM previous
      WHERE u.id = $1
      RETURNING previous.avatar_url AS previous`,
    [userId]
  )

  if (result.rowCount === 0) {
    throw new ProfileNotFoundError()
  }

  await removeAvatarFile(result.rows[0].previous)
}
