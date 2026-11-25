-- =============================================================================
-- 用户公开 UID
-- 迁移编号：0008
-- 说明：
--   1. users 增加 uid 列：面向好友查找/添加的公开身份标识，由服务端生成，
--      统一使用 8 位纯数字字符串，不直接暴露数据库自增主键；
--   2. 为所有存量用户补发 UID，新用户由列默认值自动生成；
--   3. uid 一经写入不再修改，唯一索引是最终的唯一性保证；
--   4. 生成时先查重，极小概率的并发冲突由唯一索引兜底，注册接口会重新生成重试。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 增加列（允许暂时为 NULL，便于存量数据回填）
-- -----------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS uid VARCHAR(12);

-- -----------------------------------------------------------------------------
-- 2. UID 生成函数：8 位纯数字（10000000 ~ 99999999），循环直到当前未占用
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_user_uid() RETURNS VARCHAR(12)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    candidate VARCHAR(12);
BEGIN
    LOOP
        candidate := (10000000 + floor(random() * 90000000))::bigint::text;
        EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE uid = candidate);
    END LOOP;

    RETURN candidate;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. 为存量用户补发 UID
--    逐行 UPDATE 而不是单条 UPDATE：确保每行生成时都能看到前面已分配的 UID
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    target RECORD;
BEGIN
    FOR target IN SELECT id FROM users WHERE uid IS NULL ORDER BY id LOOP
        UPDATE users SET uid = generate_user_uid() WHERE id = target.id;
    END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. 新用户默认生成 UID；列收紧为 NOT NULL
-- -----------------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN uid SET DEFAULT generate_user_uid();
ALTER TABLE users ALTER COLUMN uid SET NOT NULL;

-- -----------------------------------------------------------------------------
-- 5. 唯一索引：全局唯一，同时服务于按 UID 精确查找
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_uid ON users (uid);

COMMENT ON COLUMN users.uid IS '公开用户 UID：8 位纯数字，注册时由服务端生成，永久不变';
