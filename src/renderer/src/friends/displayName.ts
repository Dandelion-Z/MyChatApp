import type { Friend } from '../api/friends'

/**
 * 好友显示名：优先使用当前用户自己设置的备注，未设置或为空白时回退好友昵称。
 * 只用于已建立好友关系的对象，好友申请等其他场景仍使用原始昵称。
 */
export function getFriendDisplayName(friend: Pick<Friend, 'nickname' | 'remark'>): string {
  const remark = friend.remark?.trim()
  return remark ? remark : friend.nickname
}
