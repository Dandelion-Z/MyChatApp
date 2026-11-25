import type { AuthedRequest } from './friends'

export type Gender = 'male' | 'female' | 'other'

export type MyProfile = {
  id: string
  uid: string
  nickname: string
  avatarUrl: string | null
  signature: string | null
  countryCode: string | null
  provinceCode: string | null
  cityCode: string | null
  gender: Gender | null
  birthDate: string | null
  age: number | null
  level: number
  activityPoints: number
}

export type ProfileResponse = {
  success: true
  data: MyProfile
}

/** 只包含允许修改的字段；未提交的字段由服务端保持原值 */
export type ProfilePatch = {
  nickname?: string
  signature?: string | null
  countryCode?: string | null
  provinceCode?: string | null
  cityCode?: string | null
  gender?: Gender | null
  birthDate?: string | null
}

export type CountryOption = {
  code: string
  name: string
  /** 英文显示名；服务端由 Intl.DisplayNames 生成 */
  nameEn: string
}

export type RegionOption = {
  code: string
  name: string
}

export type ProvinceOption = RegionOption & {
  cities: RegionOption[]
}

export type ProfileOptions = {
  countries: CountryOption[]
  provinces: ProvinceOption[]
  versions: {
    country: { version: string; updatedAt: string }
    region: { version: string; updatedAt: string }
  }
}

export type ProfileOptionsResponse = {
  success: true
  data: ProfileOptions
}

/** 上传头像（multipart/form-data），服务端会统一压缩为 512×512 WebP 并返回完整资料 */
export async function uploadMyAvatar(
  requestWithAuth: AuthedRequest,
  file: File
): Promise<MyProfile> {
  const formData = new FormData()
  formData.append('avatar', file)
  const response = await requestWithAuth<ProfileResponse>('/api/profile/me/avatar', {
    method: 'POST',
    rawBody: formData
  })
  return response.data
}

/** 恢复默认头像，返回更新后的完整资料 */
export async function deleteMyAvatar(requestWithAuth: AuthedRequest): Promise<MyProfile> {
  const response = await requestWithAuth<ProfileResponse>('/api/profile/me/avatar', {
    method: 'DELETE'
  })
  return response.data
}

export async function getMyProfile(
  requestWithAuth: AuthedRequest,
  signal?: AbortSignal
): Promise<MyProfile> {
  const response = await requestWithAuth<ProfileResponse>(
    '/api/profile/me',
    signal ? { signal } : undefined
  )

  return response.data
}

export async function updateMyProfile(
  requestWithAuth: AuthedRequest,
  patch: ProfilePatch
): Promise<MyProfile> {
  const response = await requestWithAuth<ProfileResponse>('/api/profile/me', {
    method: 'PATCH',
    body: patch
  })

  return response.data
}

export async function getProfileOptions(
  requestWithAuth: AuthedRequest,
  signal?: AbortSignal
): Promise<ProfileOptions> {
  const response = await requestWithAuth<ProfileOptionsResponse>(
    '/api/profile/options',
    signal ? { signal } : undefined
  )

  return response.data
}

/** 好友资料：与自己资料相同的字段，另带当前用户对该好友设置的备注 */
export type FriendProfile = MyProfile & {
  remark: string | null
}

export type FriendProfileResponse = {
  success: true
  data: FriendProfile
}

export type FriendRemarkResponse = {
  success: true
  data: { remark: string | null }
}

export async function getFriendProfile(
  requestWithAuth: AuthedRequest,
  userId: string,
  signal?: AbortSignal
): Promise<FriendProfile> {
  const response = await requestWithAuth<FriendProfileResponse>(
    `/api/profile/${encodeURIComponent(userId)}`,
    signal ? { signal } : undefined
  )

  return response.data
}

/** 修改当前用户对该好友的备注；null 表示清空 */
export async function setFriendRemark(
  requestWithAuth: AuthedRequest,
  friendId: string,
  remark: string | null
): Promise<string | null> {
  const response = await requestWithAuth<FriendRemarkResponse>(
    `/api/friends/${encodeURIComponent(friendId)}/remark`,
    { method: 'PATCH', body: { remark } }
  )

  return response.data.remark
}

/** 修改密码：身份由 Access Token 决定；currentRefreshToken 仅用于保留当前设备的登录状态 */
export async function changeMyPassword(
  requestWithAuth: AuthedRequest,
  currentPassword: string,
  newPassword: string,
  currentRefreshToken: string | null
): Promise<void> {
  await requestWithAuth<{ success: true }>('/api/profile/me/password', {
    method: 'PATCH',
    body: { currentPassword, newPassword, currentRefreshToken }
  })
}
