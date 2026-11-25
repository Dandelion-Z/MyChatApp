// 文本校验与长度计算：提供注册、个人资料共用的昵称规则与 Unicode 字符计数。

const GRAPHEME_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'grapheme' })

export type TextValidation = { ok: true; value: string } | { ok: false; message: string }

/**
 * 按用户可见字符（字素簇）计数，Emoji、组合字符都算一个字符。
 */
export function graphemeLength(value: string): number {
  return Array.from(GRAPHEME_SEGMENTER.segment(value)).length
}

/**
 * 昵称规则：去除首尾空白后长度为 1～50 个字符。
 * 注册与个人资料修改共用这一套规则。
 */
export function normalizeNickname(value: string): TextValidation {
  const normalized = value.trim()

  if (normalized.length < 1 || normalized.length > 50) {
    return { ok: false, message: 'nickname 长度必须为 1～50 个字符' }
  }

  return { ok: true, value: normalized }
}
