# 永夜（MyChatApp）项目交接说明

> 更新时间：2026-11-26
> 适用版本：v1.0.0 开发版 MVP（数据库已统一为 V1；已完成一轮全量 QA 基线）
> 品牌：界面与窗口可见名称统一为「永夜」；内部项目名、包名、数据库名、API、IPC、环境变量仍为 MyChatApp/mychatapp，未改。
> 本文档面向接手开发的新会话：只读本文即可了解现状并继续开发，不必回溯历史对话。

---

## 1. 项目概况

### 1.1 产品目标与范围

永夜是一个 Windows 桌面即时通讯应用，当前目标是做出**可靠、可用的 MVP**，而不是功能完备的复杂系统。

已实现：

- 注册、登录、自动登录（Access + Refresh Token）、退出登录、修改密码
- 好友申请制添加（按 UID）、同意/拒绝、30 天自动过期、星标、备注、删除好友
- 一对一实时消息（Socket.IO）、服务端历史分页、消息幂等、30 天保留
- 自我聊天（个人备忘录，同一账号跨设备同步）
- 本地 SQLite 消息缓存与增量同步（离线可读）
- 会话云端化：`user_conversations` 管理置顶 / 免打扰 / 隐藏 / 打开 / 已读位置，未读实时聚合
- 未读数字气泡、任务栏闪烁提醒（可在会话设置里免打扰）
- 个人资料：昵称、签名、国家/省市、性别、生日与年龄、等级与活跃积分、头像上传与全局显示
- 好友资料页：查看、备注行内编辑、发消息、删除好友
- 桌面壳：无边框覆盖式标题栏、系统托盘、关闭即隐藏、窗口尺寸三态
- 自定义协议 `app://mychatapp`、CSP、CORS 白名单、Electron 启动更新门禁
- Windows NSIS 安装包配置（未签名；真实更新链路未验收）

明确不做：群聊、文件/语音/视频消息、消息撤回、已读回执 UI、多设备同时在线、多实例部署、Web/移动端、忘记密码/多因素认证。

### 1.2 技术架构

| 层         | 技术                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| 桌面客户端 | Electron 44 + React 19 + TypeScript 5.9 + electron-vite 6（Vite 8）               |
| 主进程能力 | 自定义协议、safeStorage 凭证、SQLite（`node:sqlite`）、electron-updater、窗口闪烁 |
| 服务端     | Node.js + Express 5 + Socket.IO 4 + pg + argon2 + sharp + multer                  |
| 数据库     | PostgreSQL 18（本地默认 5432），V1 基线 7 张表                                    |
| 打包       | electron-builder 26 + NSIS（per-user 安装向导）                                   |

### 1.3 目录结构

```
MyChatApp/
├─ src/
│  ├─ main/                     Electron 主进程
│  │  ├─ index.ts               窗口（无边框+托盘+图标路径解析）、协议注册、生命周期
│  │  ├─ authStorage.ts         自动登录凭证的安全存储 + 墓碑文件
│  │  ├─ localMessageStore.ts   本地 SQLite（messages / sync_cursors / chat_entries）+ IPC
│  │  └─ updater.ts             自动更新状态机与启动门禁
│  ├─ preload/                  contextBridge 暴露 window.api（仅 invoke）
│  ├─ shared/                   共享类型（authStorage、localMessages、windowLayout、windowFlash）
│  └─ renderer/src/
│     ├─ App.tsx                更新门禁 → 认证状态 → 登录页/主界面
│     ├─ components/            AuthScreen、ChatScreen、Avatar、Badge、UpdateGate
│     ├─ profile/               ProfilePage、ProfileEditForm、FriendRemark、CountryPicker、DatePicker、ChangePasswordDialog
│     ├─ auth/                  AuthContext、sessionStorage、secureStore、本地凭证
│     ├─ api/                   REST 封装（auth/friends/messages/conversations/profile/client）
│     ├─ socket/                Socket.IO 客户端状态机
│     ├─ localMessages/         本地读取封装、增量同步、会话条目、同步事件
│     ├─ friends/               统一显示名（备注优先）
│     ├─ contacts/              通讯录拼音分组
│     ├─ updater/               渲染端更新状态轮询
│     └─ assets/                全局样式、默认头像
├─ server/
│  ├─ src/index.ts              Express + Socket.IO、CORS、静态头像、清理定时器
│  ├─ src/routes|controllers    auth / friends / messages / conversations / profile
│  ├─ src/services/             auth、token、friend、friendRequest、message、conversation、profile、avatar、activityService、userPairLock、passwordPolicy
│  ├─ src/data/                 countries.ts、regions.ts（ISO 3166 与 GB/T 2260 静态数据）
│  ├─ src/middleware/           authMiddleware、rateLimit
│  ├─ src/utils/                text.ts（昵称/字素长度）
│  └─ src/socket/               Socket 认证、在线映射、message:send
├─ database/
│  ├─ migrations/               仅 0001_v1_baseline.sql（完整 V1）
│  ├─ scripts/                  migrate.ts、seed-test-users.ts
│  └─ TEST_ACCOUNTS.md          固定测试账号说明（本地使用）
├─ scripts/                     假更新服务器、打包更新测试脚本
├─ docs/AUTO_UPDATE_TESTING.md  自动更新三种测试模式
├─ build/                       图标资源（icon.png / icon.ico / icon.icns）
├─ resources/                   运行时图标（icon.png / icon.ico）
├─ .qa/                         2026-11-26 QA 使用的临时脚本（untracked，可删）
└─ electron-builder.yml         打包与 NSIS 配置
```

### 1.4 数据职责

- PostgreSQL 是消息、好友、好友申请、会话元数据、已读位置、资料与头像 URL 的权威源；同时保存 Refresh Token 哈希。
- 服务端消息默认保留 30 天（`MESSAGE_RETENTION_DAYS`），每小时清理，读取时同样按保留期过滤。
- 头像文件保存在磁盘（`AVATAR_DIR`，默认 `server/uploads/avatars`），数据库只存 `/uploads/avatars/<uuid>.webp`。
- 客户端 SQLite 是消息读缓存与会话入口缓存：同步到的消息、每好友同步游标、会话条目（含置顶/免打扰/隐藏的本地镜像、`last_opened_at_us`）。
- 客户端会话列表从服务端 `GET /api/conversations` 取成员、排序、置顶/免打扰/隐藏与元数据；接口失败时回退本地 `chat_entries`。
- 本地写入失败只告警，不影响聊天主流程。

### 1.5 环境与命令

```bash
npm install                       # 根目录
cd server && npm install && cd .. # 服务端依赖

cd server && npm run dev          # 后端（默认 3000，读取 server/.env）
npm run dev                       # 桌面端开发

npm run db:migrate                # 迁移（需 DATABASE_URL，脚本不自动读 .env）
npm run db:seed-test-users        # 固定测试账号

npm run typecheck
npm run lint
npm run build
cd server && npm run typecheck && npm run build

npm run build:win
VITE_API_BASE_URL=http://localhost:3000 npm run build:unpack   # win-unpacked（测试用）

npm run test:packaged
npm run update:fake-server        # 假更新服务器（3999）

# 一键接口 QA（必须显式提供隔离库，详见第 6 节）
QA_DATABASE_URL='postgresql://mychatapp_user:<password>@127.0.0.1:5432/mychatapp_qa' npm run test:qa
```

环境变量：

- 客户端构建期：`VITE_API_BASE_URL`（生产必须是真实 HTTPS 地址，否则生产 CSP 只允许 `'self'`）。
- 客户端运行期：`MYCHATAPP_UPDATE_URL` 可覆盖打包内 `app-update.yml` 的更新地址。
- 服务端：`PORT`、`HOST`（监听地址，默认 `127.0.0.1`，生产不要改成 `0.0.0.0`）、`DATABASE_URL`、`CORS_ORIGIN`（逗号分隔，拒绝 `*` 与 `null`）、`JWT_SECRET`（≥32 字节）、`ACCESS_TOKEN_TTL_SECONDS`（默认 900）、`MESSAGE_RETENTION_DAYS`（默认 30）、`AVATAR_DIR`（头像目录，生产需持久化）、`TRUST_PROXY`（可信反向代理地址，逗号分隔；默认不设置=不信任任何转发头）。
- 本地库测试：`MYCHATAPP_LOCAL_STORAGE_QUOTA_MB` 可临时缩小 SQLite 容量。

本机启动注意事项：

- DSH 会话 shell 默认 `ELECTRON_RUN_AS_NODE=1`，启动 Electron 必须 `env -u ELECTRON_RUN_AS_NODE`。
- 直接从 DSH 的 bash 启动 Electron 可能崩溃（`0x80000003`），用 `explorer.exe <某个.cmd>` 启动可继承用户环境。
- `dist/win-unpacked/mychatapp.exe` 在本仓库路径下会因本机环境（疑似安全软件）启动即崩；把整个目录复制到仓库外（如 `E:\mychatapp-run`）后运行正常。打包产物本身无问题。

---

## 2. 数据库 V1

两侧各自维护版本，互不混淆：数据库 V1 是**结构基线**，不是程序版本号。

### 2.1 SQLite V1（客户端本地库）

- 文件：`userData/data/messages.db`；使用 Electron 内置 `node:sqlite` 的 `DatabaseSync`。
- 版本：`PRAGMA user_version = 1`（`src/main/localMessageStore.ts` 的 `SCHEMA_VERSION = 1`）。
- 表：
  - `messages(user_id, message_id, sender_id, receiver_id, content, created_at, created_at_us, server_id, is_unread, PRIMARY KEY(user_id, message_id))`
  - `sync_cursors(user_id, peer_id, cursor, updated_at, PRIMARY KEY(user_id, peer_id))`
  - `chat_entries(user_id, peer_id, created_at_us, last_opened_at_us, is_pinned, is_muted, is_hidden, PRIMARY KEY(user_id, peer_id))`
  - 索引：`idx_messages_created_at`、`idx_messages_user_created_at`、`idx_messages_unread(user_id, is_unread)`、`idx_chat_entries_user_opened(user_id, last_opened_at_us)`
- 初始化：建表 → 读 `user_version` → 旧库补齐 `is_unread` / 会话三列 → 回填 `chat_entries` → 建索引 → 写版本。
- 旧版本兼容：开发阶段存在过 0–6 版；`LEGACY_SCHEMA_VERSION_MAX = 6`，启动时补齐列/表后把 `user_version` 归一到 1，数据保留。
- 容量：所有账号共享 1 GiB，超过 90% 按 `created_at_us` 淘汰旧消息到约 70%；不重置同步游标。
- IPC（仅 `app://mychatapp/` 或 `http://localhost:<port>/` 页面可调用）：
  `local-messages:save`、`save-many`、`list`、`sync-cursors`、`set-sync-cursor`、`stats`、`list-chats`、`ensure-chat`、`touch-chat`、`set-chat-flags`、`delete-chat`、`unread-summary`、`mark-read`、`delete-friend-data`、`chat-peers`。

### 2.2 PostgreSQL V1（服务端）

- 迁移目录只有 `database/migrations/0001_v1_baseline.sql`；`npm run db:migrate` 以文件名字典序执行。
- 版本记录：`schema_migrations(version VARCHAR PK, applied_at TIMESTAMPTZ)`；迁移成功后自动清理指向已删除文件的旧版本行。
- 序列：`users_id_seq`（内部 ID）与 `users_uid_seq`（公开 UID，`MINVALUE 10000`、`START 10001`，UID 10000 永久预留给系统账号，删除账号不回收）。
- 表与要点：
  - `users(id BIGINT IDENTITY PK, username VARCHAR(50) UNIQUE, password_hash TEXT, nickname VARCHAR(50), uid VARCHAR(20) UNIQUE NOT NULL DEFAULT generate_user_uid(), signature TEXT, country_code VARCHAR(2), province_code VARCHAR(6), city_code VARCHAR(6), gender VARCHAR(8), birth_date DATE, level SMALLINT NOT NULL DEFAULT 1, activity_points INTEGER NOT NULL DEFAULT 0, last_login_at TIMESTAMPTZ, avatar_url TEXT, is_deleted BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ)`
    - CHECK：国家两位大写、性别 male/female/other、省市六位数字、省市仅 CN、城市需省份、等级 1–9、积分非负、头像 URL 格式。
  - `friendships(user_id, friend_id, created_at, is_starred BOOLEAN NOT NULL DEFAULT FALSE, starred_at TIMESTAMPTZ, remark TEXT, PK(user_id, friend_id), CHECK(user_id <> friend_id))`：双向各一行，星标与备注各管自己一侧。
  - `messages(id BIGINT IDENTITY PK, message_id UUID UNIQUE, sender_id, receiver_id, content TEXT NOT NULL CHECK(content ~ '[^[:space:]]'), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`；索引 `idx_messages_created_at`、`idx_messages_sender_receiver_time(sender_id, receiver_id, created_at DESC)`、`idx_messages_receiver_sender_time(receiver_id, sender_id, created_at DESC)`。
  - `refresh_tokens(id, user_id, token_hash UNIQUE, expires_at, created_at, revoked_at, replaced_by_id)`；活跃用户部分索引。
  - `friend_requests(id, sender_id, receiver_id, status VARCHAR(16) CHECK(status IN ('pending','accepted','rejected','expired')), created_at, handled_at)`；`CREATE UNIQUE INDEX ... (sender_id, receiver_id) WHERE status='pending'`；另有 sender/receiver 时间索引与待处理 created 索引。
  - `user_conversations(user_id, peer_id, is_pinned, is_muted, is_hidden, last_message_at, last_message_id, last_activity_at, last_opened_at, last_read_at, last_read_message_id, created_at, updated_at, version BIGINT NOT NULL DEFAULT 0, PK(user_id, peer_id))`；排序索引 `(user_id, is_hidden, is_pinned DESC, last_activity_at DESC)`；不设 `user_id <> peer_id`（支持自我会话）。
- 回填：`0001_v1_baseline.sql` 内部幂等（`ADD COLUMN IF NOT EXISTS`、`DROP CONSTRAINT IF EXISTS` 后再 ADD、`INSERT ... ON CONFLICT DO NOTHING`），旧库执行不丢数据；`user_conversations` 从 `messages` 回填（普通双方各一条、自我一条）。
- 后续结构变更：新增 `0002_xxx.sql`（= 数据库 V2），禁止改写已应用的 `0001`。

### 2.3 版本规则

- 数据库版本与程序版本无关；不要写“v1.0.0 数据库”。
- SQLite：改动表结构时递增 `SCHEMA_VERSION`，在 `open()` 内先补列/建表，再建索引，最后写版本号；旧库必须能平滑升级。
- PostgreSQL：只追加迁移文件；文件按四位数前缀排序执行；需要时可用 `migrate.ts baseline <file>` 只登记不执行（运维场景）。

---

## 3. 已实现功能

### 3.1 认证与账号安全

- 注册：用户名 3–20 位 `[a-z0-9_]`，密码 8–128，昵称 1–50（Unicode 可见字符），UID 由服务端序列分配（10001 起）。
- 密码使用 Argon2id 哈希；登录失败统一 401「用户名或密码错误」。
- Access Token：JWT HS256，`sub` = 用户 ID，900 秒；REST 与 Socket 均校验算法与 `sub`。
- Refresh Token：32 字节 base64url，数据库只存 SHA-256；`POST /api/auth/refresh` 事务内 `FOR UPDATE` 轮换；旧 Token 重放会撤销该账号全部有效 Refresh Token。
- 自动登录：勾选后 30 天滚动有效，Refresh Token 经 `safeStorage` 加密写入 `userData/auth-credentials.bin`；登出写墓碑（只存哈希），避免旧 Token 复活。
- 修改密码：`PATCH /api/profile/me/password`，验证原密码、复用注册密码规则、拒绝与原密码相同；成功后在事务内更新哈希并撤销其他设备的 Refresh Token（当前设备凭 `currentRefreshToken` 保留）。
- 每日活跃积分：密码登录或自动登录（Refresh 轮换）成功即按 UTC 自然日 +1，同日只加一次，原子 UPDATE；等级 `level` 独立存储，本期不做升级规则。
- 限流（单进程内存，按 IP）：注册 5 次/小时、登录 10 次/15 分钟、刷新 30 次/15 分钟。

### 3.2 好友与好友申请

- 添加：按 5–19 位纯数字 UID 精确查找；`POST /api/friends/requests` 创建申请；不能加自己、不能对已是好友的人发申请、同方向 pending 唯一（反向已有 pending 会提示去处理）。
- 列表与处理：`GET /api/friends/requests` 返回收到+发出、按时间倒序，附 `pendingIncomingCount`；仅接收方可 `accept`/`reject`；同意在事务内建立双向好友关系并更新状态；拒绝不建立关系；已处理记录保留。
- 过期：pending 超过 30 天在读取/发送时懒过期，双方列表显示「已过期」，不可再同意/拒绝，可重新申请。
- 好友列表：`GET /api/friends` 返回 id、nickname、avatarUrl、isStarred、starredAt、remark、createdAt，不含 username。
- 星标：`PUT /api/friends/:friendId/star` 只改自己一侧；星标联系人置顶显示、按标记时间倒序。
- 备注：`PATCH /api/friends/:friendId/remark` 只改自己一侧；界面统一“备注优先、否则昵称”（`getFriendDisplayName`），好友资料页同时显示真实昵称。
- 删除好友：`DELETE /api/friends/:friendId` 在事务内删除双方 `friendships`、双方之间全部 `messages`、双方 `user_conversations`（好友申请记录保留）；当前客户端随后清理本地消息/会话/游标缓存，其他设备在下次成功获取好友列表后做差集清理（A5）。

### 3.3 消息

- 发送：Socket `message:send`，内容 trim 后 1–2000 字；先落库、事务提交成功才 ACK；`messageId` UUID 幂等；重复发送不重复插入、不重复推送。
- 排序：同一用户对用 `pg_advisory_xact_lock` 串行化，`created_at` 取 `clock_timestamp()`；返回微秒精度时间，客户端按 `(createdAt, serverId)` 排序。
- 推送：仅接收方在线且非自我消息时 emit `message:new`；自我消息只 ACK。
- 历史：`GET /api/messages/:friendId?limit=30&before=<cursor>`（更早）与 `after=<cursor>&order=asc`（增量）；允许查已不是好友的历史；自我聊天填自己 ID。
- 自我聊天：服务端允许 `senderId === receiverId`（跳过好友校验），会话只建一条 `(user, user)` 记录，永不产生未读。
- 保留期：默认 30 天，读取过滤 + 每小时清理；客户端本地已有记录不受影响。

### 3.4 会话与未读

- `user_conversations` 由发送事务维护（更新最近消息、清除隐藏）；`POST /api/conversations/:peerId/open` 更新 `last_opened_at` 并清除隐藏；`PATCH /api/conversations/:peerId` 使用 `version` 乐观并发（409 表示过期）。
- 未读：`GET /api/conversations` 每项返回 `unreadCount`，响应返回 `unreadTotal`；按 `(created_at, id)` 严格大于 `(last_read_at, last_read_message_id)` 聚合，仅统计对方发来的消息；自我恒 0；免打扰不影响未读。
- 已读：`POST /api/conversations/:peerId/read` 提交 `lastReadMessageId`，事务内取同一用户对锁、校验消息归属、用数据库真实时间推进（只许前进），返回最新位置与未读数。
- 客户端：会话列表以服务端为准，置顶/免打扰/删除聊天写服务端成功后同步本地镜像；隐藏会话可通过再次打开或新消息恢复；中栏会话行显示未读数字气泡，导航栏显示 `unreadTotal`。
- 已读上报：窗口有焦点 + 列表接近底部（48px 阈值）+ 最新消息带服务端 ID + 非自我会话才上报；同一会话串行、忽略乱序响应；成功后同步会话角标和导航总数。
- 409 处理：状态开关遇到过期 `version` 时自动拉取最新会话并重试一次，避免第一次点击就失败。

### 3.5 个人资料

- 字段：昵称、UID（只读、可复制）、签名（≤50 可见字符）、国家/地区（ISO 3166-1 Alpha-2，中英文名）、省份/城市（GB/T 2260，仅 CN，可留空，换省清城市、换非 CN 清省市）、性别（male/female/other，可不填）、出生日期（`YYYY-MM-DD`，禁未来）、年龄（服务端按 `Asia/Shanghai` 当天计算）、等级与活跃积分（只读）、头像。
- 数据接口：`GET /api/profile/options` 提供 250 个国家（含英文名）与 34 省 / 337 市；客户端不维护第二份数据。
- 头像：`POST /api/profile/me/avatar`（multipart 字段 `avatar`）与 `DELETE /api/profile/me/avatar`；仅接受按内容判定的 JPEG/PNG/WebP，≤5MB，宽高均 ≥128px，最长边等比缩到 ≤512（不放大、不裁剪），统一转 WebP q82；数据库只存 URL；旧文件在替换/删除时清理；静态路径 `/uploads/avatars/...`。
- 展示：导航头像、联系人、会话、聊天头部、消息气泡双方、资料页、好友申请统一使用 `Avatar` 组件；无头像/加载失败回退 `default-avatar.png`；更换头像后当前客户端即时更新，其他设备重新拉取后更新。
- 好友资料：只读查看全部字段 + 备注（行内编辑，Enter 保存、点外部取消）+ 底部「发消息」「删除好友」；无修改对方资料的入口。

### 3.6 桌面壳与界面

- 三栏：左侧 64px 导航、中间列表（默认 280px，可拖动 220–420）、右侧聊天区自适应。
- 主窗口：`titleBarStyle: 'hidden'` + `titleBarOverlay`（40px、`#F2F2F7`）；系统托盘用 `resources/icon.png`；关闭 = 隐藏到托盘；「退出登录」≠「退出程序」。
- 会话设置：聊天头部齿轮打开覆盖式面板（272px，绝对定位覆盖，不挤压消息区），含「置顶聊天」「消息免打扰」开关；点击外部/Esc/切会话关闭。
- 输入区：多行 textarea，可拖动上边框调高（44px 起，最大为聊天区一半，高度持久化到 `localStorage` 的 `mychatapp.composerHeight`）；Enter 发送、Shift+Enter 换行；Emoji 面板（48 项，插入光标处）；发送按钮固定右下。
- 联系人：右键菜单（发送消息/星标/删除好友）、整行双击开聊天、单击选中；顶部「新的朋友」入口与申请页；联系人列表不显示消息预览。
- 未读与提醒：会话未读数字气泡、「新的朋友」申请数字气泡（与导航联系人角标同源 `pendingIncomingCount`）、导航消息未读总数；新消息且窗口不在前台时任务栏闪烁（免打扰会话不闪，离线补拉整批最多闪一次）。

### 3.7 打包与更新

- `electron-builder.yml` 的 `files` 显式白名单：`out/**/*`、`package.json`、`node_modules/**/*`、`resources/**/*`；排除 `.qa/**`、`screenshots/**`、`dist/**`、`*.tsbuildinfo`、`*.log`。
- `resources/**` 配置 `asarUnpack`，主进程用 `resolveAssetPath()` 把 `app.asar` 路径映射到 `app.asar.unpacked`（托盘/窗口图标）。
- 图标：`build/icon.ico`（多尺寸 ≥256）用于 exe/安装包，`resources/icon.ico|png` 用于运行时；AUMID 与 `appId` 均为 `com.electron.app`。
- 自动更新：`electron-updater`，启动门禁 fail-closed（检查失败不进入登录页）；更新地址优先 `MYCHATAPP_UPDATE_URL`，否则读 `resources/app-update.yml`（当前为占位 `https://updates.invalid/mychatapp`）。

---

## 4. API 与 Socket 参考

### 4.1 REST（除登录/注册/刷新外均需 `Authorization: Bearer <accessToken>`）

| 方法   | 路径                                      | 说明                                             |
| ------ | ----------------------------------------- | ------------------------------------------------ |
| POST   | `/api/auth/register`                      | 注册                                             |
| POST   | `/api/auth/login`                         | 登录                                             |
| POST   | `/api/auth/refresh`                       | 轮换 Refresh Token                               |
| POST   | `/api/auth/logout`                        | 撤销当前 Refresh Token（幂等）                   |
| GET    | `/api/friends`                            | 好友列表（含 avatarUrl/remark/starred）          |
| DELETE | `/api/friends/:friendId`                  | 删除好友（级联消息与会话）                       |
| PUT    | `/api/friends/:friendId/star`             | 星标/取消                                        |
| PATCH  | `/api/friends/:friendId/remark`           | 备注（自己一侧）                                 |
| GET    | `/api/friends/requests`                   | 申请列表 + 收到待处理数                          |
| POST   | `/api/friends/requests`                   | 发送申请 `{uid}`                                 |
| POST   | `/api/friends/requests/:requestId/accept` | 同意                                             |
| POST   | `/api/friends/requests/:requestId/reject` | 拒绝                                             |
| GET    | `/api/messages/:friendId`                 | 历史（limit/before/after/order）                 |
| GET    | `/api/conversations`                      | 会话列表 + `unreadTotal`（`includeHidden` 可选） |
| POST   | `/api/conversations/:peerId/open`         | 打开/创建会话、清隐藏                            |
| POST   | `/api/conversations/:peerId/read`         | 标记已读 `{lastReadMessageId}`                   |
| PATCH  | `/api/conversations/:peerId`              | 置顶/免打扰/隐藏（带 `version`）                 |
| GET    | `/api/profile/me`                         | 自己的资料                                       |
| PATCH  | `/api/profile/me`                         | 修改资料（7 个字段，null 清空）                  |
| PATCH  | `/api/profile/me/password`                | 修改密码                                         |
| GET    | `/api/profile/options`                    | 国家/省市选项（含数据版本）                      |
| GET    | `/api/profile/:userId`                    | 好友资料（含 remark）                            |
| POST   | `/api/profile/me/avatar`                  | 上传头像（multipart `avatar`）                   |
| DELETE | `/api/profile/me/avatar`                  | 恢复默认头像                                     |
| GET    | `/uploads/avatars/<file>`                 | 头像静态文件（无鉴权，URL 不可枚举）             |

响应约定：成功 `{ success: true, ... }`；失败 `{ success: false, error: '...' }`；HTTP 状态码用于客户端分支（400/401/403/404/409/429/500）。

### 4.2 Socket.IO

- 握手：`auth.token = <accessToken>`，服务端验签并校验 `sub`；非法直接拒绝。
- 客户端 → 服务端：`message:send { toUserId, messageId, content }`，ACK `{ ok, message?, code?, error? }`。
- 服务端 → 客户端：`message:new`（仅接收方在线且非自我）、`presence:snapshot`、`session:replaced`。
- `presence:get` 返回在线好友 ID 列表（快照）；客户端连接/重连/好友刷新时查询，并每 30 秒轮询。
- 单账号单连接：新连接替换旧连接；Token 到期由服务端定时断开。

---

## 5. 安全机制

- 密码 Argon2id；Refresh Token 只存 SHA-256；Access Token 短期且无状态。
- 所有业务身份来自 Token（`request.userId` / socket `sub`），不接受客户端传入 userId。
- 好友/消息/会话/资料接口均校验归属：非好友不可发消息、非参与者不可读历史、他人资料仅好友可读、跨会话消息 ID 标记已读返回 404。
- 上传：按内容判定格式、限制 5MB、要求最短边 128、重编码为 WebP、UUID 文件名、目录不可执行；静态路由拒绝路径穿越（404）。
- CSP 与 CORS 白名单；渲染进程无 Node 权限；IPC 校验 sender；日志不打印密码/Token；错误不返回堆栈。
- 限流为单进程内存实现（重启清零、多实例不共享），共享出口 IP 会互相影响；限流键取 `req.ip`。
- 反向代理：`app.set('trust proxy', TRUST_PROXY)`，`TRUST_PROXY` 只接受显式 IP/CIDR，默认不信任；只有在 VPS 上把 Nginx 地址（通常是 `127.0.0.1`）写入该变量后，服务端才会采用 `X-Forwarded-For` 的客户端 IP。直接暴露 Node 端口时伪造的转发头不会被采信。

### 5.1 消息加密现状（重要）

- **当前版本没有端到端加密（E2EE）。**
- HTTPS/WSS 只保护客户端到服务器这一段链路，不改变服务器能看到明文的事实。
- 消息到达服务端后会以明文写入 PostgreSQL 的 `messages.content` 字段；服务器运维者、以及拥有数据库访问权限的人员可以读取消息内容。
- 不要把 HTTPS/WSS 描述成端到端加密；需要端到端加密时应单独设计密钥管理与加密协议，属于未来工作。

---

## 6. 测试基线（2026-11-26）

测试使用独立数据库 `mychatapp_qa`（空库用 V1 baseline 初始化），真实服务端 + 打包客户端；未改动 `mychatapp` 业务数据。QA 账号：qa_alice、qa_bob、qa_carol、qa_dave（以及 `legacy-friends`/`profile` 用例临时创建的 `qa_*` 账号），密码 `QaTestPass123!`（仅 QA 库）。UID 由序列分配，测试不依赖固定的 UID 数值，只校验格式与连续分配。

### 6.1 一键接口回归（`npm run test:qa`）

入口：`npm run test:qa`（`.qa/run.mjs`），需要显式传入 `QA_DATABASE_URL`，详见下方安全规则。

| 脚本                              | 覆盖                                                                                                | 结果      |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | --------- |
| `auth-edge.mjs`                   | 参数边界、空请求、非法 token                                                                        | 7/7       |
| `auth-main.mjs`                   | 注册、登录、刷新轮换、过期/错签、改密、改密后设备撤销、登出                                         | 36/36     |
| `friends.mjs`                     | 申请/重复/反向/自己/不存在、同意/拒绝/幂等、星标、备注、删好友                                      | 41/41     |
| `legacy-friends.mjs`              | 旧“按 UID 直加好友”接口已移除、申请制与拒绝流程                                                     | 16/16     |
| `socket.mjs`                      | 实时推送、幂等、错误码、历史分页、未读/已读、置顶/免打扰/版本、隐藏与恢复、重连、踢下线、删好友级联 | 66/66     |
| `profile.mjs`                     | 资料字段与校验、省市联动、生日/闰年/日期边界、头像上传/格式/尺寸/比例/缓存/安全、权限与注入         | 58/58     |
| `persist-1.mjs` / `persist-2.mjs` | 服务端重启后的数据与连接恢复                                                                        | 2/2 + 5/5 |
| `proxy-ip.mjs`                    | 可信代理下的真实 IP、伪造 XFF 防护、限流阈值、非法 TRUST_PROXY 拒绝启动                             | 7/7       |

合计 9 个脚本、238 条断言全部通过；`.qa/auth.mjs` 是早期重复脚本，不纳入一键运行。

`npm run test:qa` 的安全规则：

- 只认 `QA_DATABASE_URL`，不会回退到 `DATABASE_URL`；连上后再用 `SELECT current_database()` 复核库名必须是 `mychatapp_qa`，否则立即终止。
- 不执行 DROP/TRUNCATE/重建数据库；只按固定用户名删除 QA 账号及其关联消息/会话/好友关系/申请/Refresh Token，其他数据不动。
- Runner 自管测试服务进程：先确认端口空闲（占用则报错退出，不杀未知进程），每个脚本前重启一次以重置内存限流，测试结束（含异常）只结束自己启动的进程树。
- 报告会给出每个脚本的执行状态、通过/失败数与耗时；任一脚本失败以非零退出码结束。
- 反向代理/限流取址用例 `proxy-ip.mjs` 已包含在 `npm run test:qa` 中（会自行在 3101–3103 端口启动临时服务）。

### 6.2 数据库 V1 验证（通过）

- SQLite：空库初始化、v6/v4/v2 旧库升级、真实开发库副本升级，共 14 项通过；数据条数与置顶/免打扰/隐藏状态保留，`integrity_check=ok`。
- PostgreSQL：现有库执行 baseline 幂等、历史版本记录清理、数据与 UID 序列保留；空库重建后与现有库 `pg_dump --schema-only` 结构一致（7 表、74 约束、20 索引）；重复迁移 0 待执行。

### 6.3 打包与 GUI 走查

- `VITE_API_BASE_URL=http://localhost:3000 npm run build:unpack` 成功；产物复制到仓库外目录运行（本仓库路径下有环境性启动崩溃，见 1.5）。
- 实际走查：登录页、注册入口、主界面、会话列表、消息列表、联系人、个人资料、好友资料、好友申请页、聊天窗口、会话设置面板、窗口 1280×800→1024×700 缩放；全程无渲染进程未捕获错误。
- 双客户端（qa_alice / qa_bob 两个独立打包实例、独立 userData）完成：用 UID 加好友、互发消息、实时接收、未读角标与导航总数、聚焦后已读清零、置顶/免打扰、备注、删除好友与重登验证；相关断言全部通过。

### 6.4 本轮发现并修复的问题

1. **P0 打包内容不洁**：`files` 未显式白名单，asar 内混入 `.qa/`、`screenshots/`、旧 `dist/`、`*.tsbuildinfo`，根 `package.json` 被替换为 HTML 片段导致应用无法启动。已改 `electron-builder.yml` 白名单并排除测试目录，重建后 asar 只含 `node_modules`、`out`、`resources`、`package.json`。
2. **P1 打包后图标路径失效**：`resources/**` 被 `asarUnpack` 后仍按 `app.asar/resources/...` 读取，托盘创建抛未处理拒绝、窗口/托盘图标加载失败。新增 `resolveAssetPath()` 映射到 `app.asar.unpacked`。
3. **P2 置顶开关可能一次失败**：其他设备（或已读上报）推进 `version` 后，首次 PATCH 返回 409 直接提示失败。改为 409 时拉取最新会话并重试一次；已验证过期版本下仍一次成功。
4. 未发现 P0 级数据安全问题；接口越权、SQL 注入、上传安全、日志泄露检查均通过。

### 6.5 未执行或无法执行

- 真实 HTTPS 更新源全链路（下载→静默安装→重启→再次检查）：当前只有同版本假源。
- 代码签名安装包的安装/卸载/SmartScreen 行为。
- 多显示器不同缩放、跨 DPI 拖动、长时间驻留。
- macOS 构建（`build/icon.icns` 仍为模板图标）。
- GUI 自动化未覆盖：系统托盘右键菜单、系统标题栏按钮（需人工确认）。

---

## 7. 已知问题与技术限制

1. 自动更新依赖真实 HTTPS 源、代码签名与 `latest.yml`/安装包/blockmap 上传；`publish.url` 仍是占位地址。
2. `dist/win-unpacked` 是本地测试构建（CSP 指向 `http://localhost:3000`），正式发布必须用真实 `VITE_API_BASE_URL` 重建。
3. Access Token 无状态，登出/改密后最长 15 分钟内仍可能有效；改密会撤销其他设备 Refresh Token。
4. 未勾选自动登录时异常退出，服务端临时 Refresh Token 会残留到 24 小时过期。
5. 在线状态最多约 30 秒延迟（轮询），不做上下线广播。
6. 限流为单进程内存实现：重启清零、多实例不共享；共享出口 IP 会互相影响。反向代理需在服务端设置 `TRUST_PROXY=<Nginx 地址>`（默认不信任任何转发头），否则所有请求会被算作同一个代理 IP。
7. 多实例部署需要 Redis adapter / 粘性会话，当前未做。
8. 本地 SQLite 清理按时间全局淘汰，不区分账号/会话；清理后不会主动回补。
9. 双开同一 userData 的凭证写入仍是后写覆盖（墓碑与精确清理已缓解，未做全覆盖文件锁）。
10. 安装包未签名，Windows SmartScreen 可能拦截。
11. 已读位置不做 Socket 广播，多端/多会话未读数刷新不实时；已读判定用“窗口有焦点 + 距底部 48px”的近似规则。
12. 隐藏会话默认不出现在 `GET /api/conversations`，因此不计入客户端未读角标；未读接口失败时客户端回退本地统计，可能短暂不一致。
13. 头像公开可访问（URL 不可枚举）；未做 CDN/缓存服务；更改头像后其他设备需重新拉取。
14. 省市数据仅中文名（国家有中英文名）；港澳台无下级市；省直辖县级市未支持（济源、仙桃等）。
15. 备注只在客户端“备注优先”显示，不进入好友列表搜索关键词。
16. 中文分组的多音字按 ICU 默认读音（曾→C、单→D、解→J）。
17. 40px 标题条固定 `#F2F2F7`，在登录页与白色联系人栏上方有极浅色带边界，已接受。
18. 关闭主窗口只是隐藏，必须通过托盘「退出程序」结束进程。
19. `refresh_tokens` 历史行不自动清理，只影响本地测试库。
20. `resources/icon.icns` 仍是模板图标（仅 macOS 使用）。
21. 打包 exe 在 `E:\MyChatApp\dist\win-unpacked` 路径下启动即崩（0x80000003，疑似本机安全软件），复制到仓库外运行正常；已排除 exe 与 asar 内容问题，确认为环境因素。

---

## 8. 尚未实现的功能

- 群聊、文件/图片/语音/视频消息、消息撤回、已读回执 UI、输入中状态
- 忘记密码、邮箱/手机验证、多因素认证、登录设备管理页面
- 多设备同时在线、会话/未读的 Socket 广播、离线推送
- 头像裁剪/滤镜、等级升级规则与积分流水、资料隐私设置、好友分组
- 联系人列表按备注搜索、系统托盘菜单更多项（开机自启、启动最小化）
- **端到端加密（E2EE）与客户端消息加密、密钥管理机制**（当前服务端可读消息明文，见 5.1）
- CI 集成（一键 `npm run test:qa` 已可用，尚未接入自动化流水线）

---

## 9. VPS 部署要求与当前进度

### 9.1 组件

- Node.js 22+、PostgreSQL 18、反向代理（Nginx/Caddy）提供 HTTPS 与 WebSocket 升级。
- 服务端目录 + `npm ci --omit=dev`；客户端 `VITE_API_BASE_URL` 指向 `https://<域名>`。

### 9.2 必须配置

- `DATABASE_URL`（生产库、最小权限账号）、`JWT_SECRET`（≥32 字节随机）、`PORT`、`CORS_ORIGIN`（`app://mychatapp` + 必要的正式来源）、`MESSAGE_RETENTION_DAYS`、`AVATAR_DIR`（持久化卷，如 `/var/lib/mychatapp/uploads`）。
- 数据库执行迁移：`DATABASE_URL=... npx tsx database/scripts/migrate.ts migrate`。
- 反向代理必须：透传 `Authorization`、支持 WebSocket（`/socket.io/` 升级）、上传体积上限 ≥6MB、`/uploads/` 由服务端静态或代理直出、HTTPS 证书。
- 监听地址：服务端 `httpServer.listen(PORT, HOST)`，`HOST` 默认 `127.0.0.1`（`server/.env.example` 已给出），即只有本机 Nginx 能访问 Node 业务端口；`HOST` 可用环境变量覆盖，但生产环境不要设置为 `0.0.0.0`/`::`。
- 真实客户端 IP（限流依赖）：Node 只监听 `127.0.0.1`，Nginx 与 Node 同机时设置
  `TRUST_PROXY=127.0.0.1`；Nginx 必须覆盖转发头，避免客户端伪造：

  ```nginx
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  ```

  同时保留 `Host`、`Upgrade`、`Connection` 用于 WebSocket。**不要**设置 `TRUST_PROXY=true` 或固定跳数；未设置 `TRUST_PROXY` 时服务端会忽略 `X-Forwarded-For`，所有请求按代理地址计数。

- 公网只暴露 443（必要时 80 跳转），Node 业务端口不对外开放。
- 防火墙只暴露 443（与必要时的 80）；PostgreSQL 不对公网开放。
- 备份：PostgreSQL 定时 `pg_dump` + `AVATAR_DIR` 快照；恢复演练。

### 9.3 客户端发布

- 用真实 `VITE_API_BASE_URL` 构建；配置真实更新源 `publish.url` 或运行期 `MYCHATAPP_UPDATE_URL`；生成 `latest.yml` + 安装包 + blockmap 并上传；安装包代码签名（建议）。
- CSP 会随 `VITE_API_BASE_URL` 自动放行 API origin 与 `ws/wss`；务必确认构建产物 `index.html` 的 CSP 正确。

### 9.4 当前进度

- 本地开发与打包验证完成（数据库 V1、全量接口测试、打包态 GUI 走查、双客户端流程）。
- 尚未部署到任何 VPS；未配置真实 HTTPS API、更新源、代码签名；未做生产备份与监控。
- 本机打包 exe 在仓库路径下启动崩溃属环境问题，部署/发布不涉及该路径，不视为阻塞。

---

## 10. 后续开发建议

1. 先完成 VPS 封闭测试部署：真实 HTTPS、更新源、签名、持久化上传目录与备份。
2. 把 `.qa/` 的接口脚本整理成可重复运行的测试（数据库隔离 + 环境变量），并入 CI。
3. 为多实例做准备时再引入 Redis（Socket adapter、限流共享），当前保持单实例。
4. 优化已读体验：可考虑更精确的“底部可见”判定与跨设备广播（需新增协议，属于后续阶段）。
5. 若需要图片/文件消息，先设计对象存储与消息模型，不要复用头像静态目录。
6. 关注 `resources/icon.icns` 与 macOS 构建（如要支持 macOS）。

---

## 11. 交接提醒与关键回归点

- 不要删除固定测试账号，不要用宽泛 SQL 清理“所有用户/所有消息”。
- 修改好友/消息逻辑时必须验证：删除好友后不能发新消息、双方云端消息与会话被清理、旧 `messageId` 仍幂等、重新加好友后的本地缓存不复活旧数据。
- 修改 Socket 认证/连接管理时注意单连接替换、StrictMode、被踢提示。
- 修改本地记录/同步时必须验证：同步未完成走服务端、完成后本地优先、分页来源不混用、去重与排序不变。
- 修改认证/凭证时必须验证：自动登录、登出撤销、改密后其他设备 Refresh 失效、墓碑不复活旧 Token。
- 修改本地库 schema 时：先补列再建索引，并用“旧版本库 + 新版本库 + 空目录”三种起点启动验证。
- 修改导航/会话列表/未读时：注意 `chat_entries` 唯一键、`last_opened_at_us` 双职责，以及服务端 `user_conversations.version` 的 409 重试逻辑。
- 改动主进程窗口/托盘/图标时：保持窗口与托盘单例、`isQuitting` 语义、`close` 拦截；打包后图标必须走 `resolveAssetPath`。
- 「退出登录」与「退出程序」是两件事，任何改动都不要让其一取代另一。
- `HANDOFF.md` 已从打包内容中排除，不会进入安装包。

---

## 12. 固定测试账号与环境事实（本地开发库 `mychatapp`）

| 用户名         | 昵称       | UID   | 用途                 |
| -------------- | ---------- | ----- | -------------------- |
| `test_alice`   | 测试用户 A | 10001 | 主要发送方           |
| `test_bob`     | 测试用户 B | 10002 | 主要接收方           |
| `test_charlie` | 测试用户 C | 10003 | 次要接收方           |
| `test_david`   | 测试用户 D | 10004 | 加好友/申请/删除验证 |

- 密码与数据管理规则见 `database/TEST_ACCOUNTS.md`（仅本地开发，不要用于正式环境）。
- `db:seed-test-users` 只保证 Alice ↔ Bob；其他关系可能需手工补。
- 当前 QA 使用独立库 `mychatapp_qa`，未改动 `mychatapp` 的业务数据；QA 账号不应带入生产。
- 本机服务与端口在 QA 结束后已停止：3000、3999、9222–9232 无监听；无 `mychatapp.exe` 进程。
- 工作区有大量未提交修改与未跟踪文件，接手先 `git status`，不要误删或回滚。
- 当前判断：**具备进入 VPS 封闭测试的条件**（功能与数据链路已通过本地实际验证），前提是按第 9 节完成真实 HTTPS、更新源、签名与持久化上传目录配置。
