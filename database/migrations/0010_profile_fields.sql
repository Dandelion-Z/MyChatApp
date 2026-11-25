-- 个人资料第一阶段：用户资料字段与好友备注
-- 所有新增字段均可空，保证旧账号无需回填即可继续使用。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signature TEXT NULL,
  ADD COLUMN IF NOT EXISTS country_code VARCHAR(2) NULL,
  ADD COLUMN IF NOT EXISTS province_code VARCHAR(6) NULL,
  ADD COLUMN IF NOT EXISTS city_code VARCHAR(6) NULL,
  ADD COLUMN IF NOT EXISTS gender VARCHAR(10) NULL,
  ADD COLUMN IF NOT EXISTS birth_date DATE NULL;

COMMENT ON COLUMN users.signature IS '个性签名，最多 50 个用户可见字符';
COMMENT ON COLUMN users.country_code IS 'ISO 3166-1 Alpha-2 国家/地区代码，大写';
COMMENT ON COLUMN users.province_code IS '中国省级行政区划代码（GB/T 2260，六位）';
COMMENT ON COLUMN users.city_code IS '中国地级行政区划代码（GB/T 2260，六位）';
COMMENT ON COLUMN users.gender IS '性别标准值：male / female / other';
COMMENT ON COLUMN users.birth_date IS '出生日期（DATE，不含时间与时区）';

-- 先删除再新增，保证迁移可重复执行
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

-- 省市只允许在中国大陆（CN）下填写；代码是否真实存在由服务端行政区划数据校验。
-- 用 COALESCE 避免 country_code 为 NULL 时 CHECK 结果为 NULL 而绕过约束。
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

-- 好友备注：沿用双向 friendships 记录，user_id 一侧保存该用户给 friend_id 设置的备注
ALTER TABLE friendships ADD COLUMN IF NOT EXISTS remark TEXT NULL;
COMMENT ON COLUMN friendships.remark IS '当前用户（user_id）给对方（friend_id）设置的备注，双方独立';
