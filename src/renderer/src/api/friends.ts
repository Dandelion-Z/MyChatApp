import type { RequestOptions } from './client'

export type Friend = {
  id: string
  username: string
  nickname: string
  createdAt: string
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
