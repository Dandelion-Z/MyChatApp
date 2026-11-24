-- 好友申请 30 天过期：扩展状态枚举并补充懒过期所需的索引。
-- 过期由服务端在读取列表 / 发送申请 / 处理申请时懒处理，不引入后台定时任务。

ALTER TABLE friend_requests
  DROP CONSTRAINT IF EXISTS friend_requests_status_check;

ALTER TABLE friend_requests
  ADD CONSTRAINT friend_requests_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected', 'expired'));

-- 懒过期只扫描仍为 pending 的记录，部分索引可避免扫到已处理的历史申请
CREATE INDEX IF NOT EXISTS idx_friend_requests_pending_created
  ON friend_requests (created_at)
  WHERE status = 'pending';

COMMENT ON COLUMN friend_requests.status IS '申请状态：pending 待处理 / accepted 已同意 / rejected 已拒绝 / expired 已过期';
COMMENT ON COLUMN friend_requests.handled_at IS '接收方处理时间，或懒过期时间；pending 时为 NULL';
