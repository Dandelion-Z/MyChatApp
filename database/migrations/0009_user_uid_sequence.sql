-- =============================================================================
-- 用户公开 UID：随机数字 -> 连续递增序列
-- 迁移编号：0009
-- 说明：
--   1. users.uid 扩展为 VARCHAR(20)，继续以字符串传递；
--   2. 存量用户按注册时间升序（相同时间按内部 id）重新分配连续 UID：
--      10001、10002、10003……；10000 永久预留给未来系统官方账号，
--      普通用户分配从 10001 开始；
--   3. 新建 PostgreSQL SEQUENCE 作为普通用户的唯一分配来源，
--      nextval() 在数据库层保证并发注册不重复，且已删除账号的 UID 不会回收；
--   4. generate_user_uid() 改为从序列取下一个值，不再随机生成；
--   5. 唯一索引与 NOT NULL 约束保持不变；用户内部 id、好友关系、
--      好友申请、历史消息等业务数据均不修改。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 扩展列长度（序列最大值可到 19 位）
-- -----------------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN uid TYPE VARCHAR(20);

-- -----------------------------------------------------------------------------
-- 2. 存量用户重新分配连续 UID
--    旧 UID 为 8 位随机数（>= 10000000），与 10001 起的连续值不会冲突；
--    同一条 UPDATE 内新值本身也互不重复。
-- -----------------------------------------------------------------------------
WITH ranked AS (
    SELECT
        id,
        (10000 + ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC))::text AS new_uid
    FROM users
)
UPDATE users
SET uid = ranked.new_uid
FROM ranked
WHERE users.id = ranked.id;

-- -----------------------------------------------------------------------------
-- 3. 普通用户 UID 序列
--    MINVALUE 设为 10000：即使将来手工 setval(10000)，首个 nextval 也是 10001，
--    普通注册流程在序列层面不可能拿到 10000。
--    当前游标推进到存量最大 UID，下一个注册用户取到 max + 1。
-- -----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS users_uid_seq
    AS BIGINT
    INCREMENT BY 1
    MINVALUE 10000
    MAXVALUE 9223372036854775807
    START WITH 10001
    NO CYCLE;

-- setval 后 nextval 返回 value + 1；没有用户时从 10000 起算，首个注册得 10001
SELECT setval(
    'users_uid_seq',
    GREATEST(10000, COALESCE((SELECT MAX(uid::bigint) FROM users), 10000))
);

-- -----------------------------------------------------------------------------
-- 4. 生成函数改为从序列取值；列的默认值、NOT NULL 与唯一约束继续保持
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_user_uid() RETURNS VARCHAR(20)
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    RETURN nextval('users_uid_seq')::text;
END;
$$;

ALTER TABLE users ALTER COLUMN uid SET DEFAULT generate_user_uid();
ALTER TABLE users ALTER COLUMN uid SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_uid ON users (uid);

COMMENT ON COLUMN users.uid IS '公开用户 UID：5~19 位纯数字，由 users_uid_seq 连续递增分配（10000 预留给系统账号），永久不变、删除后不回收';
