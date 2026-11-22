-- =============================================================================
-- MyChatApp Refresh Token 表
-- 迁移编号：0002
-- 说明：支持「自动登录」所需的长期凭证。数据库只保存 Token 的 SHA-256 哈希，
--       不保存明文；每次刷新都会轮换（旧记录标记为已撤销）。
--       本迁移只新增一张独立表，不修改已有表与数据。
-- =============================================================================

CREATE TABLE refresh_tokens (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- 归属用户；用户被物理删除时一并清理（软删除用户不允许刷新）
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- SHA-256(明文 Token) 的十六进制表示，唯一，用于按哈希查找
    token_hash CHAR(64) NOT NULL UNIQUE,
    -- true：勾选自动登录，30 天滚动有效期；false：仅当前运行期使用，24 小时
    is_persistent BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    -- 非空表示已被轮换或主动撤销，不允许再次使用
    revoked_at TIMESTAMPTZ,
    -- 轮换后的新 Token，便于审计；旧记录被删除时置空
    replaced_by_id BIGINT REFERENCES refresh_tokens (id) ON DELETE SET NULL
);

-- 按用户查询仍有效的凭证（撤销检测、批量失效使用）
CREATE INDEX idx_refresh_tokens_user_active
    ON refresh_tokens (user_id)
    WHERE revoked_at IS NULL;
