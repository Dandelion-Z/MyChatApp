import type React from 'react'
import { formatBadgeCount } from './badgeFormat'

/** 角标显示模式：数字角标 / 纯红点 */
export type BadgeMode = 'count' | 'dot'

export interface BadgeProps {
  /** 显示模式，默认数字模式 */
  mode?: BadgeMode
  /** 数字模式下的数量：<= 0 时不渲染角标 */
  count?: number
  /** 数字模式的封顶值，超过后显示 `${max}+`，默认 99 */
  max?: number
  /**
   * 附加类名，用于控制定位或页面内的尺寸微调。
   * 组件自身不带定位（position），叠加在图标上时传 `badge-overlay` 即可。
   */
  className?: string
  /** 无障碍文本，默认「N 条未读」/「有新提醒」 */
  label?: string
}

/**
 * 通用角标组件：只负责展示，不感知任何业务状态。
 *
 * 叠加使用：
 * ```tsx
 * <span className="badge-anchor">
 *   <SomeIcon />
 *   <Badge count={12} className="badge-overlay" />
 * </span>
 * ```
 */
export function Badge({
  mode = 'count',
  count = 0,
  max = 99,
  className,
  label
}: BadgeProps): React.JSX.Element | null {
  const isDot = mode === 'dot'
  const value = Number.isFinite(count) ? Math.floor(count) : 0

  if (!isDot && value <= 0) {
    return null
  }

  const classes = ['badge', isDot ? 'badge-dot' : '', className ?? '']
    .filter((name) => name !== '')
    .join(' ')
  const text = isDot ? null : formatBadgeCount(value, max)
  const accessibleLabel = label ?? (isDot ? '有新提醒' : `${value} 条未读`)

  return (
    <span className={classes} role="status" aria-label={accessibleLabel} title={accessibleLabel}>
      {text}
    </span>
  )
}
