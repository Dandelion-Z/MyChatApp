-- -----------------------------------------------------------------------------
-- 好友星标
-- 说明：friendships 是双向记录，每条记录代表「该用户自己这一侧」的好友关系，
--       因此星标只写入当前登录用户的记录，不会影响对方。
--       starred_at 为 NULL 表示未星标；取消星标时一并清空时间。
-- -----------------------------------------------------------------------------
ALTER TABLE friendships
    ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE friendships
    ADD COLUMN IF NOT EXISTS starred_at TIMESTAMPTZ NULL;
