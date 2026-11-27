-- =============================================================================
-- Polar Night PostgreSQL 初始结构 V1（基线）
--
-- 本文件把开发阶段 0001 ~ 0012 的全部结构变更整合为一份完整的 V1 结构。
-- 全新数据库直接执行本文件即可得到与当前代码完全匹配的库；
-- 已经执行过历史迁移的开发库同样可以安全执行本文件（全部语句幂等），
-- 执行后由迁移脚本登记为 V1 基线，不需要按顺序重跑历史迁移。
--
-- 版本规则：
--   - 本文件是唯一的结构基线，对应数据库结构版本 V1；
--   - 之后任何结构变更新增 0002_xxx.sql（V2）、0003_xxx.sql（V3）……
--   - 数据库结构版本与应用程序版本无关。
--
-- 注意：本文件不创建 schema_migrations，版本记录表由迁移脚本自行维护。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. 用户 UID 序列与生成函数
--    MINVALUE = 10000：普通用户从 10001 开始，10000 永久预留给系统官方账号。
-- -----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS users_uid_seq
    AS BIGINT
    INCREMENT BY 1
    MINVALUE 10000
    MAXVALUE 9223372036854775807
    START WITH 10001
    NO CYCLE;

CREATE OR REPLACE FUNCTION generate_user_uid() RETURNS VARCHAR(20)
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    RETURN nextval('users_uid_seq')::text;
END;
$$;

COMMENT ON FUNCTION generate_user_uid() IS '分配公开用户 UID：从 users_uid_seq 连续递增取值';

-- -----------------------------------------------------------------------------
-- 1. 用户表
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    nickname VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    uid VARCHAR(20) NOT NULL DEFAULT generate_user_uid(),
    signature TEXT NULL,
    country_code VARCHAR(2) NULL,
    province_code VARCHAR(6) NULL,
    city_code VARCHAR(6) NULL,
    gender VARCHAR(10) NULL,
    birth_date DATE NULL,
    level SMALLINT NOT NULL DEFAULT 1,
    activity_points INTEGER NOT NULL DEFAULT 0,
    last_login_at TIMESTAMPTZ NULL,
    avatar_url TEXT NULL
);

-- 兼容更早的开发库：逐列补齐（新库上全部为 no-op）
ALTER TABLE users ADD COLUMN IF NOT EXISTS uid VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code VARCHAR(2) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS province_code VARCHAR(6) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city_code VARCHAR(6) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(10) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS level SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT NULL;

-- 为极早期、还没有 UID 的数据补发（正常开发库此时没有 NULL）
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM users WHERE uid IS NULL) THEN
        UPDATE users SET uid = nextval('users_uid_seq')::text WHERE uid IS NULL;
    END IF;
END;
$$;

-- 序列游标至少推进到现有最大 UID；空库或序列已更靠前时保持不变
DO $$
DECLARE
    max_uid BIGINT;
BEGIN
    SELECT COALESCE(MAX(uid::bigint), 10000) INTO max_uid FROM users;

    IF max_uid >= (SELECT last_value FROM users_uid_seq) THEN
        PERFORM setval('users_uid_seq', GREATEST(max_uid, 10000));
    END IF;
END;
$$;

ALTER TABLE users ALTER COLUMN uid SET DEFAULT generate_user_uid();
ALTER TABLE users ALTER COLUMN uid SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_uid ON users (uid);

-- 用户资料 / 等级 / 头像约束（先删后建，保证可重复执行）
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_country_code_format_check;
ALTER TABLE users
    ADD CONSTRAINT users_country_code_format_check
    CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_gender_check;
ALTER TABLE users
    ADD CONSTRAINT users_gender_check
    CHECK (gender IS NULL OR gender IN ('male', 'female', 'other'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_province_code_format_check;
ALTER TABLE users
    ADD CONSTRAINT users_province_code_format_check
    CHECK (province_code IS NULL OR province_code ~ '^[0-9]{6}$');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_city_code_format_check;
ALTER TABLE users
    ADD CONSTRAINT users_city_code_format_check
    CHECK (city_code IS NULL OR city_code ~ '^[0-9]{6}$');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_region_country_check;
ALTER TABLE users
    ADD CONSTRAINT users_region_country_check
    CHECK (
        (province_code IS NULL AND city_code IS NULL)
        OR COALESCE(country_code = 'CN', FALSE)
    );

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_city_requires_province_check;
ALTER TABLE users
    ADD CONSTRAINT users_city_requires_province_check
    CHECK (city_code IS NULL OR province_code IS NOT NULL);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_level_range_check;
ALTER TABLE users
    ADD CONSTRAINT users_level_range_check
    CHECK (level >= 1 AND level <= 9);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_activity_points_non_negative_check;
ALTER TABLE users
    ADD CONSTRAINT users_activity_points_non_negative_check
    CHECK (activity_points >= 0);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_avatar_url_format_check;
ALTER TABLE users
    ADD CONSTRAINT users_avatar_url_format_check
    CHECK (avatar_url IS NULL OR avatar_url ~ '^/uploads/avatars/[a-z0-9-]+\.webp$');

COMMENT ON COLUMN users.uid IS '公开用户 UID：5~19 位纯数字，由 users_uid_seq 连续递增分配（10000 预留给系统账号），永久不变、删除后不回收';
COMMENT ON COLUMN users.signature IS '个性签名，最多 50 个用户可见字符';
COMMENT ON COLUMN users.country_code IS 'ISO 3166-1 Alpha-2 国家/地区代码，大写';
COMMENT ON COLUMN users.province_code IS '中国省级行政区划代码（GB/T 2260，六位）';
COMMENT ON COLUMN users.city_code IS '中国地级行政区划代码（GB/T 2260，六位）';
COMMENT ON COLUMN users.gender IS '性别标准值：male / female / other';
COMMENT ON COLUMN users.birth_date IS '出生日期（DATE，不含时间与时区）';
COMMENT ON COLUMN users.level IS '用户当前等级，预留 LV.1–LV.9，独立于积分存储';
COMMENT ON COLUMN users.activity_points IS '累计活跃积分，每日首次成功登录（UTC 自然日）增加 1 点';
COMMENT ON COLUMN users.last_login_at IS '最后一次成功登录的准确时间，用于判定积分是否跨自然日';
COMMENT ON COLUMN users.avatar_url IS '头像访问路径（/uploads/avatars/<uuid>.webp）；NULL 表示默认头像';

-- -----------------------------------------------------------------------------
-- 2. 好友关系表（双向记录，每条代表 user_id 自己这一侧）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friendships (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    friend_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_starred BOOLEAN NOT NULL DEFAULT FALSE,
    starred_at TIMESTAMPTZ NULL,
    remark TEXT NULL,
    PRIMARY KEY (user_id, friend_id)
);

ALTER TABLE friendships ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE friendships ADD COLUMN IF NOT EXISTS starred_at TIMESTAMPTZ NULL;
ALTER TABLE friendships ADD COLUMN IF NOT EXISTS remark TEXT NULL;

ALTER TABLE friendships DROP CONSTRAINT IF EXISTS friendships_check;
ALTER TABLE friendships ADD CONSTRAINT friendships_check CHECK (user_id <> friend_id);

COMMENT ON COLUMN friendships.remark IS '当前用户（user_id）给对方（friend_id）设置的备注，双方独立';
COMMENT ON COLUMN friendships.is_starred IS '当前用户是否星标该好友；只影响自己这一侧';
COMMENT ON COLUMN friendships.starred_at IS '星标时间，NULL 表示未星标';

-- -----------------------------------------------------------------------------
-- 3. 消息表
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id UUID UNIQUE NOT NULL,
    sender_id BIGINT NOT NULL REFERENCES users (id),
    receiver_id BIGINT NOT NULL REFERENCES users (id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_not_blank;
ALTER TABLE messages ADD CONSTRAINT messages_content_not_blank CHECK (content ~ '[^[:space:]]');

CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver_time
    ON messages (sender_id, receiver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_receiver_sender_time
    ON messages (receiver_id, sender_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
    ON messages (created_at);

-- -----------------------------------------------------------------------------
-- 4. Refresh Token 表（自动登录长期凭证，只保存 SHA-256 哈希）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    is_persistent BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    replaced_by_id BIGINT REFERENCES refresh_tokens (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
    ON refresh_tokens (user_id)
    WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- 5. 好友申请表
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friend_requests (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sender_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    receiver_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    handled_at TIMESTAMPTZ NULL
);

ALTER TABLE friend_requests DROP CONSTRAINT IF EXISTS friend_requests_status_check;
ALTER TABLE friend_requests
    ADD CONSTRAINT friend_requests_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'expired'));

ALTER TABLE friend_requests DROP CONSTRAINT IF EXISTS friend_requests_not_self_check;
ALTER TABLE friend_requests
    ADD CONSTRAINT friend_requests_not_self_check
    CHECK (sender_id <> receiver_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_requests_pending_direction
    ON friend_requests (sender_id, receiver_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_friend_requests_sender_time
    ON friend_requests (sender_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver_time
    ON friend_requests (receiver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friend_requests_pending_created
    ON friend_requests (created_at)
    WHERE status = 'pending';

COMMENT ON TABLE friend_requests IS '好友申请；pending 表示待处理，accepted/rejected 为已处理状态';
COMMENT ON COLUMN friend_requests.status IS '申请状态：pending 待处理 / accepted 已同意 / rejected 已拒绝 / expired 已过期';
COMMENT ON COLUMN friend_requests.handled_at IS '接收方处理时间，或懒过期时间；pending 时为 NULL';

-- -----------------------------------------------------------------------------
-- 6. 用户会话表（服务端权威的会话元数据与已读位置）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_conversations (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    peer_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_muted BOOLEAN NOT NULL DEFAULT FALSE,
    is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
    last_message_at TIMESTAMPTZ NULL,
    last_message_id BIGINT NULL,
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_opened_at TIMESTAMPTZ NULL,
    last_read_at TIMESTAMPTZ NULL,
    last_read_message_id BIGINT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_user_conversations_user_order
    ON user_conversations (user_id, is_hidden, is_pinned DESC, last_activity_at DESC);

COMMENT ON TABLE user_conversations IS '账号级会话展示状态；普通聊天双方各一行，自我聊天 peer_id = user_id';
COMMENT ON COLUMN user_conversations.last_message_id IS '最近消息 ID 快照，不设外键（消息存在 30 天清理）';
COMMENT ON COLUMN user_conversations.last_read_message_id IS '最后已读消息 ID，不设外键，与 last_read_at 组成已读位置';
COMMENT ON COLUMN user_conversations.version IS '乐观并发版本号，写接口按 version 做 CAS';

-- 历史会话回填：普通聊天双方各一条，自我聊天一条；幂等且不覆盖已有管理状态
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
