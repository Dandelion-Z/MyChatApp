import type { RequestOptions } from './client'

export type Friend = {
  id: string
  username: string
  nickname: string
  createdAt: string
  /** 当前用户是否星标了该好友（只影响自己这一侧的关系记录） */
  isStarred: boolean
  /** 星标标记时间；未星标时为 null */
  starredAt: string | null
}

export type FriendsResponse = {
  success: true
  friends: Friend[]
}

export type AddedFriend = {
  id: string
  username: string
  nickname: string
}

export type AddFriendResponse = {
  success: true
  data: AddedFriend
}

export type RemoveFriendResponse = {
  success: true
  message: string
}

/** 与 AuthContext.requestWithAuth 相同的签名，避免 API 模块直接依赖 React Context */
export type AuthedRequest = <T>(path: string, options?: RequestOptions) => Promise<T>

export async function getFriends(
  requestWithAuth: AuthedRequest,
  signal?: AbortSignal
): Promise<Friend[]> {
  const response = await requestWithAuth<FriendsResponse>(
    '/api/friends',
    signal ? { signal } : undefined
  )

  return response.friends
}

export async function addFriend(
  requestWithAuth: AuthedRequest,
  username: string
): Promise<AddedFriend> {
  const response = await requestWithAuth<AddFriendResponse>('/api/friends', {
    method: 'POST',
    body: { username }
  })

  return response.data
}

export async function removeFriend(
  requestWithAuth: AuthedRequest,
  friendId: string
): Promise<void> {
  await requestWithAuth<RemoveFriendResponse>(`/api/friends/${encodeURIComponent(friendId)}`, {
    method: 'DELETE'
  })
}

export type FriendStarState = {
  friendId: string
  isStarred: boolean
  starredAt: string | null
}

export type SetFriendStarResponse = {
  success: true
  data: FriendStarState
}

/** 标记 / 取消星标；服务端只改当前登录用户自己的关系记录，返回最新状态 */
export async function setFriendStar(
  requestWithAuth: AuthedRequest,
  friendId: string,
  starred: boolean
): Promise<FriendStarState> {
  const response = await requestWithAuth<SetFriendStarResponse>(
    `/api/friends/${encodeURIComponent(friendId)}/star`,
    {
      method: 'PUT',
      body: { starred }
    }
  )

  return response.data
}

export type FriendRequestDirection = 'incoming' | 'outgoing'
export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired'

export type FriendRequestItem = {
  id: string
  direction: FriendRequestDirection
  status: FriendRequestStatus
  /** 申请的另一方：收到的申请是发送者，发出的申请是接收者 */
  user: AddedFriend
  createdAt: string
  /** 接收方处理时间；待处理时为 null */
  handledAt: string | null
}

export type FriendRequestsResponse = {
  success: true
  requests: FriendRequestItem[]
  /** 当前用户收到的待处理申请数，用于「新的朋友」红点 */
  pendingIncomingCount: number
}

export type FriendRequestResponse = {
  success: true
  data: FriendRequestItem
}

/**
 * 当前用户收到 + 发出的好友申请，服务端已按申请时间倒序。
 * 同时返回收到的待处理数量，用于红点提醒。
 */
export async function getFriendRequests(
  requestWithAuth: AuthedRequest,
  signal?: AbortSignal
): Promise<FriendRequestsResponse> {
  const response = await requestWithAuth<FriendRequestsResponse>(
    '/api/friends/requests',
    signal ? { signal } : undefined
  )

  return response
}

/** 发送好友申请（不直接建立好友关系） */
export async function sendFriendRequest(
  requestWithAuth: AuthedRequest,
  username: string
): Promise<FriendRequestItem> {
  const response = await requestWithAuth<FriendRequestResponse>('/api/friends/requests', {
    method: 'POST',
    body: { username }
  })

  return response.data
}

export async function acceptFriendRequest(
  requestWithAuth: AuthedRequest,
  requestId: string
): Promise<FriendRequestItem> {
  const response = await requestWithAuth<FriendRequestResponse>(
    `/api/friends/requests/${encodeURIComponent(requestId)}/accept`,
    { method: 'POST' }
  )

  return response.data
}

export async function rejectFriendRequest(
  requestWithAuth: AuthedRequest,
  requestId: string
): Promise<FriendRequestItem> {
  const response = await requestWithAuth<FriendRequestResponse>(
    `/api/friends/requests/${encodeURIComponent(requestId)}/reject`,
    { method: 'POST' }
  )

  return response.data
}
