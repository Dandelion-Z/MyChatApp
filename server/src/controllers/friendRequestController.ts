import type { Request, Response } from 'express'
import { validateFriendUsername } from './friendController'
import {
  CannotAddSelfError,
  DuplicateFriendshipError,
  UserNotFoundError
} from '../services/friendService'
import {
  DuplicateFriendRequestError,
  FriendRequestForbiddenError,
  FriendRequestNotFoundError,
  FriendRequestStateError,
  ReverseFriendRequestError,
  acceptFriendRequest,
  createFriendRequest,
  getFriendRequests,
  rejectFriendRequest
} from '../services/friendRequestService'

const REQUEST_ID_PATTERN = /^[1-9]\d*$/
const MAX_BIGINT = 9223372036854775807n

type ValidationResult = { ok: true; value: string } | { ok: false; message: string }

/** 校验并解析申请 ID（路径参数） */
function validateRequestId(value: string | string[] | undefined): ValidationResult {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    return { ok: false, message: 'requestId 格式不正确' }
  }

  if (BigInt(value) > MAX_BIGINT) {
    return { ok: false, message: 'requestId 超出 BIGINT 范围' }
  }

  return { ok: true, value }
}

export async function listFriendRequests(request: Request, response: Response): Promise<void> {
  // 当前用户只能来自 JWT 中间件写入的 request.userId
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  try {
    const result = await getFriendRequests(currentUserId)
    response.status(200).json({
      success: true,
      requests: result.requests,
      pendingIncomingCount: result.pendingIncomingCount
    })
  } catch (error) {
    console.error('查询好友申请失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

export async function sendFriendRequest(request: Request, response: Response): Promise<void> {
  // 当前用户只能来自 JWT 中间件写入的 request.userId
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const validation = validateFriendUsername(request.body)

  if (!validation.ok) {
    response.status(400).json({ success: false, error: validation.message })
    return
  }

  try {
    const friendRequest = await createFriendRequest(currentUserId, validation.value)
    response.status(201).json({ success: true, data: friendRequest })
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      response.status(404).json({ success: false, error: '用户不存在' })
      return
    }

    if (error instanceof CannotAddSelfError) {
      response.status(400).json({ success: false, error: '不能给自己发送好友申请' })
      return
    }

    if (error instanceof DuplicateFriendshipError) {
      response.status(409).json({ success: false, error: '你们已经是好友，无需重复添加' })
      return
    }

    if (
      error instanceof DuplicateFriendRequestError ||
      error instanceof ReverseFriendRequestError
    ) {
      response.status(409).json({ success: false, error: error.message })
      return
    }

    console.error('发送好友申请失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

/** 同意申请：服务层在事务中同时建立双向好友关系并更新状态 */
export async function acceptFriendRequestHandler(
  request: Request,
  response: Response
): Promise<void> {
  // 当前用户只能来自 JWT 中间件写入的 request.userId
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const validation = validateRequestId(request.params.requestId)

  if (!validation.ok) {
    response.status(400).json({ success: false, error: validation.message })
    return
  }

  try {
    const friendRequest = await acceptFriendRequest(currentUserId, validation.value)
    response.status(200).json({ success: true, data: friendRequest })
  } catch (error) {
    if (error instanceof FriendRequestNotFoundError) {
      response.status(404).json({ success: false, error: error.message })
      return
    }

    if (error instanceof FriendRequestForbiddenError) {
      response.status(403).json({ success: false, error: error.message })
      return
    }

    if (error instanceof FriendRequestStateError) {
      response.status(409).json({ success: false, error: error.message })
      return
    }

    console.error('同意好友申请失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}

/** 拒绝申请：只更新状态，不建立好友关系 */
export async function rejectFriendRequestHandler(
  request: Request,
  response: Response
): Promise<void> {
  // 当前用户只能来自 JWT 中间件写入的 request.userId
  const currentUserId = request.userId

  if (!currentUserId) {
    response.status(401).json({ success: false, error: '未授权' })
    return
  }

  const validation = validateRequestId(request.params.requestId)

  if (!validation.ok) {
    response.status(400).json({ success: false, error: validation.message })
    return
  }

  try {
    const friendRequest = await rejectFriendRequest(currentUserId, validation.value)
    response.status(200).json({ success: true, data: friendRequest })
  } catch (error) {
    if (error instanceof FriendRequestNotFoundError) {
      response.status(404).json({ success: false, error: error.message })
      return
    }

    if (error instanceof FriendRequestForbiddenError) {
      response.status(403).json({ success: false, error: error.message })
      return
    }

    if (error instanceof FriendRequestStateError) {
      response.status(409).json({ success: false, error: error.message })
      return
    }

    console.error('拒绝好友申请失败：', error instanceof Error ? error.message : String(error))
    response.status(500).json({ success: false, error: '服务器内部错误' })
  }
}
