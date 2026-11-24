-- 0007 用户会话表
--
-- 会话是“某个账号看到的某条聊天”的展示状态，按 (user_id, peer_id) 一人一行：
-- 普通聊天双方各一条；自我聊天 peer_id = user_id，只有一条。
-- 会话不依赖 friendships：删除好友只删好友关系，会话与历史消息都保留。
-- 未读数量本阶段不落库，后续由最后已读位置 + messages 计算。

CREATE TABLE IF NOT EXISTS user_conversations (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    peer_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- 展示管理位：置顶 / 免打扰 / 删除聊天（只隐藏入口，不删历史）
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_muted BOOLEAN NOT NULL DEFAULT FALSE,
    is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
    -- 最近一条消息的快照。不设消息外键：messages 有 30 天清理策略，
    -- 会话需要比消息存活更久，消息被清理后这里允许保留悬挂 ID。
    last_message_at TIMESTAMPTZ NULL,
    last_message_id BIGINT NULL,
    -- 用于列表排序：只要会话有新消息就前进，与 last_message_at 分开便于后续补状态
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- 最近打开时间与最后已读位置（本阶段只读，不写入）
    last_opened_at TIMESTAMPTZ NULL,
    last_read_at TIMESTAMPTZ NULL,
    last_read_message_id BIGINT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- 乐观并发版本号，写接口接入后使用
    version BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, peer_id)
);

COMMENT ON TABLE user_conversations IS '账号级会话展示状态；普通聊天双方各一行，自我聊天 peer_id = user_id';
COMMENT ON COLUMN user_conversations.last_message_id IS '最近消息 ID 快照，不设外键（消息存在 30 天清理）';
COMMENT ON COLUMN user_conversations.last_read_message_id IS '最后已读消息 ID，不设外键，与 last_read_at 组成已读位置';
COMMENT ON COLUMN user_conversations.version IS '乐观并发版本号，写接口按 version 做 CAS';

-- 列表查询：按用户取会话、过滤隐藏、置顶优先、组内按最新活动时间倒序
CREATE INDEX IF NOT EXISTS idx_user_conversations_user_order
    ON user_conversations (user_id, is_hidden, is_pinned DESC, last_activity_at DESC);

-- -----------------------------------------------------------------------------
-- 历史会话回填
--
-- 普通聊天：发送方与接收方各生成一条（接收方那一侧只在 sender_id <> receiver_id
-- 时补，避免自我聊天重复）；自我聊天：UNION 的第二个分支被条件排除，只留一条。
-- 有消息即视为会话存在，不检查好友关系是否仍在。
-- 幂等：ON CONFLICT DO NOTHING，重复执行不会重复插入，也不会覆盖已有管理状态
-- （置顶、免打扰、隐藏、已读位置等）。
-- -----------------------------------------------------------------------------
WITH conversation_messages AS (
    SELECT
        id,
        created_at,
        sender_id AS user_id,
        receiver_id AS peer_id
    FROM messages

    UNION ALL

    SELECT
        id,
        created_at,
        receiver_id AS user_id,
        sender_id AS peer_id
    FROM messages
    WHERE sender_id <> receiver_id
),
ranked AS (
    SELECT
        user_id,
        peer_id,
        id,
        created_at,
        MIN(created_at) OVER (PARTITION BY user_id, peer_id) AS first_message_at,
        ROW_NUMBER() OVER (
            PARTITION BY user_id, peer_id
            ORDER BY created_at DESC, id DESC
        ) AS rn
    FROM conversation_messages
)
INSERT INTO user_conversations (
    user_id,
    peer_id,
    created_at,
    last_activity_at,
    last_message_at,
    last_message_id,
    updated_at
)
SELECT
    user_id,
    peer_id,
    first_message_at,
    created_at,
    created_at,
    id,
    CURRENT_TIMESTAMP
FROM ranked
WHERE rn = 1
ON CONFLICT (user_id, peer_id) DO NOTHING;
