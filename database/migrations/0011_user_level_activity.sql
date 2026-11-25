-- 等级与活跃积分：等级单独存储，不根据积分自动换算
ALTER TABLE users ADD COLUMN IF NOT EXISTS level SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_level_range_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_level_range_check CHECK (level >= 1 AND level <= 9);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_activity_points_non_negative_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_activity_points_non_negative_check CHECK (activity_points >= 0);
  END IF;
END
$$;

COMMENT ON COLUMN users.level IS '用户当前等级，预留 LV.1–LV.9，独立于积分存储';
COMMENT ON COLUMN users.activity_points IS '累计活跃积分，每日首次成功登录（UTC 自然日）增加 1 点';
COMMENT ON COLUMN users.last_login_at IS '最后一次成功登录的准确时间，用于判定积分是否跨自然日';
