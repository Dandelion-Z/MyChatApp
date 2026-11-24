-- =============================================================================
-- 好友申请
-- 迁移编号：0005
-- 适用数据库：PostgreSQL
-- 说明：新增 friend_requests 表，记录发送方、接收方、状态与处理时间。
--       好友关系仍以 friendships 为准；同意申请时才在事务中建立双向关系。
-- =============================================================================

CREATE TABLE friend_requests (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sender_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    receiver_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    handled_at TIMESTAMPTZ NULL,
    CONSTRAINT friend_requests_status_check CHECK (status IN ('pending', 'accepted', 'rejected')),
    CONSTRAINT friend_requests_not_self_check CHECK (sender_id <> receiver_id)
);

-- 同一方向最多只能有一条待处理申请；已处理的历史记录不受影响
CREATE UNIQUE INDEX uq_friend_requests_pending_direction
    ON friend_requests (sender_id, receiver_id)
    WHERE status = 'pending';

-- 收到 / 发出的申请都按时间倒序展示
CREATE INDEX idx_friend_requests_sender_time
    ON friend_requests (sender_id, created_at DESC);

CREATE INDEX idx_friend_requests_receiver_time
    ON friend_requests (receiver_id, created_at DESC);

COMMENT ON TABLE friend_requests IS '好友申请；pending 表示待处理，accepted/rejected 为已处理状态';
COMMENT ON COLUMN friend_requests.handled_at IS '接收方同意或拒绝的时间；pending 时为 NULL';
