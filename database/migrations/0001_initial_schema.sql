-- =============================================================================
-- MyChatApp 初始数据库结构
-- 迁移编号：0001
-- 适用数据库：PostgreSQL
-- 说明：在全新数据库中创建 users、friendships、messages 三张表，
--       以及两个消息查询索引。
-- 注意：本文件只包含首次建库所需的语句，不包含数据、不包含版本记录表。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 用户表
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    nickname VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- -----------------------------------------------------------------------------
-- 2. 好友关系表
-- 说明：使用 (user_id, friend_id) 复合主键；两个外键均级联删除；
--       禁止用户把自己加为好友。
-- -----------------------------------------------------------------------------
CREATE TABLE friendships (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    friend_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, friend_id),
    CHECK (user_id <> friend_id)
);

-- -----------------------------------------------------------------------------
-- 3. 消息表
-- 说明：id 为内部自增主键，message_id 为业务唯一标识（UUID）；
--       消息内容不允许全为空白字符。
-- -----------------------------------------------------------------------------
CREATE TABLE messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id UUID UNIQUE NOT NULL,
    sender_id BIGINT NOT NULL REFERENCES users (id),
    receiver_id BIGINT NOT NULL REFERENCES users (id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (content ~ '[^[:space:]]')
);

-- -----------------------------------------------------------------------------
-- 4. 消息查询索引
-- 说明：分别覆盖「某用户发出的消息」和「某用户收到的消息」按时间查询的场景。
-- -----------------------------------------------------------------------------
CREATE INDEX idx_messages_sender_receiver_time
    ON messages (sender_id, receiver_id, created_at DESC);

CREATE INDEX idx_messages_receiver_sender_time
    ON messages (receiver_id, sender_id, created_at DESC);
