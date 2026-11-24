/** 数字角标的展示文案：1~max 原样展示，超过 max 显示 `max+` */
export function formatBadgeCount(count: number, max = 99): string {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 99
  const value = Number.isFinite(count) ? Math.floor(count) : 0

  return value > limit ? `${limit}+` : String(value)
}
