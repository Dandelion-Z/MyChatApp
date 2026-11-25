/**
 * 密码规则：与注册流程保持一致，只做长度约束（8～128 个字符）。
 * 注册与修改密码共用这一处定义，避免两套规则漂移。
 */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

export function isValidPasswordFormat(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH
}
