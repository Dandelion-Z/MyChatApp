-- 用户头像：只保存本服务托管的 WebP 相对路径，NULL 表示使用客户端默认头像。
-- 具体文件存放在服务端 AVATAR_DIR（默认 server/uploads/avatars），不写入数据库。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- 约束：只允许 /uploads/avatars/<文件名>.webp 形式，避免把任意外链或脚本路径写进来。
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_avatar_url_format_check;
ALTER TABLE users
  ADD CONSTRAINT users_avatar_url_format_check
  CHECK (avatar_url IS NULL OR avatar_url ~ '^/uploads/avatars/[a-z0-9-]+\.webp$');

COMMENT ON COLUMN users.avatar_url IS '头像访问路径（/uploads/avatars/<uuid>.webp）；NULL 表示默认头像';
