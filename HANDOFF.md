# 永夜（MyChatApp）项目交接说明

> 更新时间：2026-11-25
> 适用版本：v1.0.0（MVP 收尾、生产化、本地聊天记录、消息未读提醒、UI 改造第一阶段、会话云端化 A3 均已完成）
> 品牌：界面与窗口可见名称统一为「永夜」；内部项目名、包名、数据库名、API、IPC、环境变量仍为 MyChatApp/mychatapp，未改。
> 本文档面向接手开发的新会话：只读本文即可了解现状并继续开发，不必回溯历史对话。

---

## 1. 项目概况

### 1.1 产品目标与 MVP 范围

MyChatApp 是一个桌面即时通讯应用，当前目标是做出**可靠、可用的 MVP**，而不是功能完备的复杂系统。

MVP 已包含：

- 用户注册、登录、自动登录（Access + Refresh Token）
- 好友添加 / 删除 / 列表
- 一对一实时消息（Socket.IO）
- 服务端历史消息（向上分页）
- 在线状态、连接状态提示、同账号被踢提示
- 本地聊天记录（SQLite 持久化、服务端增量同步、聊天界面本地优先读取）
- 会话列表与未读提醒（本地持久化、导航栏数字角标）
- 会话云端化：PostgreSQL `user_conversations`、服务端已读位置、服务端未读统计（客户端已接入）
- 桌面壳：无边框覆盖式标题栏、Windows 系统托盘、关闭即隐藏
- Windows 安装包
- 自动更新（electron-updater，启动门禁）
- 生产形态的 Electron 自定义 Protocol、CSP、CORS 白名单

明确不做：群聊、用户搜索、文件/语音/视频消息、消息撤回、已读回执、多设备同时在线、多实例部署、Web/移动端。

已落地（详见 2.8、2.11 与第 9 节）：好友申请（申请-同意）、星标联系人、自我聊天、会话置顶/免打扰/删除聊天、任务栏闪烁提醒、会话云端化（A1–A3）。

### 1.2 技术架构

| 层 | 技术 |
| --- | --- |
| 桌面客户端 | Electron 44 + React 19 + TypeScript 5.9 + electron-vite 6（Vite 8） |
| 主进程能力 | 自定义协议、safeStorage 凭证、SQLite（`node:sqlite`）、electron-updater |
| 服务端 | Node.js + Express + Socket.IO 4 + pg |
| 数据库 | PostgreSQL 18（本地 5432），三张业务表 + refresh_tokens |
| 打包 | electron-builder 26 + NSIS（per-user 安装向导） |

### 1.3 目录结构

```
MyChatApp/
├─ src/
│  ├─ main/                     Electron 主进程
│  │  ├─ index.ts               窗口（无边框+托盘）、协议注册、生命周期、各模块注册
│  │  ├─ authStorage.ts         自动登录凭证的安全存储 + 墓碑文件
│  │  ├─ localMessageStore.ts   本地 SQLite 消息库、会话表、未读标记、同步游标
│  │  └─ updater.ts             自动更新状态机与启动门禁
│  ├─ preload/                  contextBridge 暴露 window.api（仅 invoke）
│  ├─ shared/                   主进程 / preload / 渲染进程共享类型
│  │  ├─ authStorage.ts         RendererApi 定义
│  │  ├─ localMessages.ts       本地库 + 未读 + 会话列表 API 类型
│  │  └─ windowLayout.ts        窗口尺寸三态（login/register/chat）
│  └─ renderer/src/
│     ├─ App.tsx                更新门禁 → 认证状态 → 登录页/聊天页，外层窗口壳
│     ├─ components/            AuthScreen、ChatScreen、UpdateGate、Badge
│     ├─ auth/                  AuthContext、sessionStorage、secureStore、本地凭证
│     ├─ api/                   REST 封装（auth/friends/messages/conversations/client）
│     ├─ socket/                Socket.IO 客户端状态机
│     ├─ localMessages/         本地读取封装、增量同步、会话条目、同步事件
│     ├─ contacts/              通讯录拼音分组（Intl.Collator）
│     ├─ updater/               渲染端更新状态轮询
│     └─ assets/                全局样式
├─ server/
│  ├─ src/index.ts              Express + Socket.IO 启动、CORS、清理定时器
│  ├─ src/routes|controllers    auth / friends / messages / conversations
│  ├─ src/services/             auth、token、friend、friendRequest、message、conversation、userPairLock、jwt
│  ├─ src/middleware/           authMiddleware、rateLimit
│  └─ src/socket/               Socket 认证、在线映射、message:send
├─ database/
│  ├─ migrations/               0001 初始、0002 refresh_tokens、0003 保留期、0004 星标、0005 好友申请、0006 申请过期、0007 user_conversations
│  ├─ scripts/                  migrate.ts、seed-test-users.ts
│  └─ TEST_ACCOUNTS.md          固定测试账号说明（含本地测试密码，仅本地使用）
├─ scripts/                     假更新服务器、打包更新测试脚本
├─ docs/AUTO_UPDATE_TESTING.md  自动更新三种测试模式说明
├─ build/                       图标与签名资源
└─ electron-builder.yml         打包与 NSIS 配置
```

### 1.4 数据职责

- PostgreSQL 是消息、好友、账号、Refresh Token 的权威数据源。
- 服务端只保留最近 30 天消息（`MESSAGE_RETENTION_DAYS` 可调），每小时清理一次，读取时同样按保留期过滤。
- 客户端 SQLite 保存三样东西：同步到的消息、每好友同步游标、会话条目（`chat_entries`，含 `last_opened_at_us` 与未读状态来源），均按账号隔离；服务端删除过期消息不影响本地已有记录。
- 客户端 SQLite 是聊天界面的读缓存，本地写入失败不影响聊天主流程；本地库不可用时会话列表会退化为空（不会崩溃）。
- 服务端 `user_conversations` 是会话元数据与已读位置的权威源；未读数由消息表实时聚合，不存计数器。客户端会话列表（置顶/免打扰/删除聊天）仍以本地 SQLite 为权威，仅未读数取服务端。

### 1.5 环境与命令

前置：Node.js + npm、本地 PostgreSQL、已执行迁移。

```bash
# 安装依赖（根目录，安装 Electron 等）
npm install

# 后端开发（默认 3000，读取 server/.env 的 DATABASE_URL / CORS_ORIGIN）
cd server && npm install && npm run dev

# 桌面端开发（electron-vite；默认连接 http://localhost:3000）
npm run dev

# 数据库
npm run db:migrate          # 执行未应用的迁移
npm run db:seed-test-users  # 初始化固定测试账号（两个库）

# 工程检查
npm run typecheck           # 客户端 main/preload/renderer
npm run lint
npm run build               # typecheck + electron-vite build
cd server && npm run typecheck && npm run build

# 打包
npm run build:win                                                     # 生成 NSIS 安装包
VITE_API_BASE_URL=http://localhost:3000 npx electron-builder --dir    # 仅生成 win-unpacked（测试用）

# Windows 桌面一键启动（开发版）
# 双击 C:\Users\Windows\OneDrive\桌面\永夜开发版一键启动.bat
# 行为：检查 3000 端口（自家服务端则复用；被其它程序占用则提示并退出，不杀进程）
#      → 空闲则新窗口启动 `cd server && npm run dev` → 轮询 /health 最多 90s
#      → 就绪后新窗口启动 `npm run dev`（Electron 开发版）
# 注意：Electron 从批处理启动前必须真正删除 ELECTRON_RUN_AS_NODE（set VAR=&&），
#      写成 `set VAR= ` 会留下空格值，Electron 仍按 Node 模式运行并报错。

# 自动更新测试
npm run test:packaged                  # 构建 + 假更新服务器 + 独立 userData 启动
npm run test:packaged -- --skip-build --smoke
npm run update:fake-server             # 单独启动假更新服务器（默认 3999）
```

环境变量：

- 客户端构建期：`VITE_API_BASE_URL`（生产必须配置为真实 HTTPS 地址，否则生产 CSP 只允许 `'self'`，登录会提示无法连接服务器）。
- 客户端运行期：`MYCHATAPP_UPDATE_URL` 可覆盖打包内 `app-update.yml` 的更新地址。
- 服务端：`PORT`、`DATABASE_URL`、`CORS_ORIGIN`（逗号分隔，拒绝 `*` 与 `null`）、`JWT_SECRET`（≥32 字节）、`ACCESS_TOKEN_TTL_SECONDS`（默认 900，测试用）、`MESSAGE_RETENTION_DAYS`（默认 30）。
- 本地库测试：`MYCHATAPP_LOCAL_STORAGE_QUOTA_MB` 可临时缩小 SQLite 容量，验证清理逻辑。

---

## 2. 当前功能与开发进度

状态口径：**已完成并验收** = 已实现且做过针对性验证；**已完成未验收** = 已实现但未做端到端验证；**已知限制** = 明确记录、暂不处理。

### 2.1 认证与账号安全（已完成并验收）

- 注册：用户名 3–20 位 `[a-z0-9_]`，密码 8–128，昵称 1–50；密码用 **Argon2id** 哈希。
- 登录：统一 401「用户名或密码错误」，不泄露账号是否存在；成功返回 Access Token + Refresh Token。
- Access Token：JWT HS256，`sub` 为用户 ID，有效期 900 秒；REST 与 Socket 握手都校验算法与 `sub`，业务只信任 Token 中的身份。
- Refresh Token：32 字节 base64url，数据库只存 SHA-256；勾选自动登录 30 天滚动有效，未勾选仅 24 小时且只存内存。
- 刷新：`POST /api/auth/refresh` 事务内 `FOR UPDATE` 轮换，旧 Token 立即失效并记录 `replaced_by_id`；检测到已撤销 Token 被重放会撤销该账号全部有效 Refresh Token。
- 登出：`POST /api/auth/logout` 幂等撤销当前 Refresh Token；客户端同时清 sessionStorage 与本地安全存储。
- 客户端会话：`sessionStorage` 键 `mychatapp.auth`；提前 60 秒刷新、请求前 5 秒预检、401 后刷新并只重试一次、网络错误 10 秒后重试。
- 自动登录：Refresh Token 经 Electron `safeStorage` 加密后写入 `userData/auth-credentials.bin`（原子写、最多 10 个账号、损坏自愈）；登出时写 `tombstones.json` 墓碑（只存哈希），避免“解密暂时失败 → 登出 → 旧 Token 复活”；墓碑写入带跨进程文件锁。
- 认证接口限流（按 IP 内存固定窗口）：注册 5 次/小时、登录 10 次/15 分钟、Refresh 30 次/15 分钟；`/logout` 不限流。

### 2.2 好友与一对一聊天（已完成并验收）

- 好友：`POST/GET/DELETE /api/friends`；双向 `friendships` 记录，事务写入；重复添加返回 409；删除只删好友关系，不删消息。
  - 当前添加方式是「按用户名直接建立关系」，**下一阶段将改为好友申请-同意制**，届时本节接口与前端流程都会调整。
- 消息发送：Socket `message:send` → 校验参数（内容 trim 后 1–2000 字、不能发给自己、必须是好友）→ 事务写库 → 提交成功后才 ACK；接收方在线才推送 `message:new`。
- 幂等：客户端生成 `messageId`（UUID），服务端先查后插、`ON CONFLICT DO NOTHING`，重发同一 ID 不会重复；失败重发复用原 ID。
- 消息排序：服务端返回微秒精度 `createdAt`，客户端按微秒文本排序，完全相等时用服务端自增 ID 兜底，避免并发事务错序。
- 历史消息：`GET /api/messages/:friendId?limit=30&before=<cursor>`（更早）与 `after=<cursor>&order=asc`（增量同步）；只查当前用户与对方的双向消息，不要求当前仍是好友；返回按时间升序。
- 聊天界面：向上滚动加载更早 30 条（滚动位置保持）、失败可重试、每个好友独立草稿（切换不串）、输入上限 2000 字、发送失败标记 `failed` 可重发、重连后补拉每个好友最近 30 条。
- 断线/被踢：连接状态不再占用侧边栏文字，改为导航栏头像右下角的状态点（绿=在线、橙=连接中、红=离线，完整文案在 `title`/`aria-label`）；同账号新登录时服务端先发 `session:replaced` 再断开旧连接，旧客户端提示「该账号已在其他位置登录，当前设备已退出。」并清理凭证回登录页，不会自动重连。

### 2.3 在线状态（已完成并验收）

- 服务端 `Map<userId, socketId>` 单账号单连接；新连接替换旧连接；按 Token 过期时间定时断开；`disconnect` 时只在映射仍指向自己时清理。
- `presence:get` 返回在线好友快照 `presence:snapshot`；客户端连接/重连/好友列表刷新时查询，并每 30 秒轮询。
- 好友头像右下角绿点表示在线；不做上线/下线广播，因此状态有最多约 30 秒延迟。

### 2.4 Electron Protocol / CSP / CORS / Windows 安装包（已完成并验收）

- 生产页面使用自定义协议 `app://mychatapp/index.html`（standard、secure、supportFetchAPI、corsEnabled），主进程协议处理器做路径规范化与越界拦截（403/404），文件通过 `net.fetch(file://…)` 返回；生产 Origin 为 `app://mychatapp`，不再是 `null`。
- CSP 由 `electron.vite.config.ts` 在构建时按 `VITE_API_BASE_URL` 生成并注入 `index.html`：生产禁止行内脚本，`connect-src` 为 `'self'` + API origin + 对应 ws/wss；开发额外允许 Vite HMR。
- 服务端 CORS 默认白名单 `http://localhost:5173` 与 `app://mychatapp`，可用 `CORS_ORIGIN` 覆盖；拒绝通配符与 `null`；Socket.IO 额外用 `allowRequest` 校验 Origin。
- 打包：electron-builder + NSIS，`oneClick:false`、允许选择安装目录、per-user 安装、`differentialPackage: store-asar`（为差分更新准备）；产物 `dist/mychatapp-1.0.0-setup.exe` 与 `dist/win-unpacked/`。
- `asar.contentAlignment: 512` 在当前 electron-builder 26.18 的 schema 中不存在，写入会导致构建失败，因此**未配置**；等官方支持后再补。
- 打包排除 `server/`、`database/`、`scripts/`、`docs/`、`.env*`、`HANDOFF.md`；仅包含 `out/`、`package.json`、`resources/` 与生产依赖。

### 2.5 自动更新（已完成，真实链路未验收）

- `electron-updater` 6.6.2；更新由主进程管理，渲染端只通过 preload IPC 读取状态/触发重试。
- 启动顺序：窗口创建前检查更新 → 渲染端 `UpdateGate` 显示「正在检查更新 / 下载中… / 正在安装…」；**检查通过才渲染登录页**，失败显示错误与重试按钮（fail-closed，无关闭开关）。
- 发现新版本自动下载，下载完成自动 `quitAndInstall` 重启；重启后重新检查，确认无更新才进入登录。
- 地址解析：优先 `MYCHATAPP_UPDATE_URL`；否则读打包产物 `resources/app-update.yml` 的 `url:`。打包配置里的 `publish.url` 目前是占位 `https://updates.invalid/mychatapp`，发布前必须替换或运行期覆盖。
- 开发模式（`!app.isPackaged`）直接放行，不检查更新。
- 测试流程见 `docs/AUTO_UPDATE_TESTING.md`：开发模式 / 打包测试模式（假更新服务器 + 独立 userData）/ 正式安装测试模式（真实 HTTPS 源），注意 `--dir` 构建不含 `app-update.yml`、假服务器要匹配 `?noCache=` 查询串。

### 2.6 本地聊天记录（已完成并验收）

**存储（主进程）**

- 数据库：`userData/data/messages.db`，使用 Electron 内置 `node:sqlite` 的 `DatabaseSync`，无额外依赖。
- 表结构（schema v4，`PRAGMA user_version=4`，迁移按版本逐级执行且保留旧数据）：
  - `messages(user_id, message_id, sender_id, receiver_id, content, created_at, created_at_us, server_id, is_unread, PRIMARY KEY(user_id,message_id))`
  - `sync_cursors(user_id, peer_id, cursor, updated_at, PRIMARY KEY(user_id,peer_id))`
  - `chat_entries(user_id, peer_id, created_at_us, last_opened_at_us, PRIMARY KEY(user_id,peer_id))`（v3 引入，会话列表；`last_opened_at_us` 同时作为「已读到哪」的判据）
  - 索引：`idx_messages_unread(user_id, is_unread)`、`idx_chat_entries_user_opened(user_id, last_opened_at_us)`
- 迁移注意（曾经踩过）：v4 的 `is_unread` 列必须**先** `ALTER TABLE` 补列，**再**建 `idx_messages_unread` 索引；若把建索引写在 `CREATE_SCHEMA_SQL` 里，旧库会因为列不存在直接抛 `no such column: is_unread`，导致 `open()` 失败、所有本地 IPC 连锁不可用。当前实现：建表 → 检测列 → 必要时 ALTER → 统一建索引 → 写 `user_version`。
- 旧数据兼容：v2→v3 用 `INSERT OR IGNORE ... SELECT` 从 `messages` 回填 `chat_entries`；v3→v4 旧消息的 `is_unread` 默认 0（视为已读），不回算未读；`saveMessages` 插入新消息时也会补建缺失的 `chat_entries`（覆盖全新库首同步的情况）。
- 去重键为 `(user_id, message_id)`：同一账号重复写入忽略，不同账号互不影响。
- 容量：所有账号共享 1 GiB（`MYCHATAPP_LOCAL_STORAGE_QUOTA_MB` 仅测试用），超过 90% 后按 `created_at_us` 从旧到新删除，回落到约 70%，随后 `incremental_vacuum` + WAL checkpoint；本地清理不会重置同步游标，因此不会重新下载已清理的旧消息。
- IPC：`local-messages:save`、`save-many`、`list`、`sync-cursors`、`set-sync-cursor`、`stats`、`list-chats`、`ensure-chat`、`touch-chat`、`unread-summary`、`mark-read`；只允许 `app://mychatapp/` 或 `http://localhost:<port>/` 页面调用。

**同步（渲染进程）**

- 登录后每个账号触发一次增量同步（`syncedUserIdRef` 防重复，卸载时中止）。
- 每个好友独立游标；服务端按 `after` 升序分页（每页 100，单好友最多 200 页），并发 2 个好友。
- 每页先 `saveMany` 成功，再推进游标；失败保留旧游标，下次登录重试。
- 只补拉服务端当前仍保留的消息；离线超过 30 天只补现有消息，不尝试恢复已删除内容。
- 每页成功后通过渲染进程事件通知聊天界面。

**聊天界面读取**

- 首次打开会话：若该好友同步已完成（本次运行期的同步状态为 `complete`）且本地有记录 → 用本地游标分页；否则走服务端历史（本地记录可能只覆盖历史中段，避免遗漏）。
- 分页来源在会话首次加载时锁定为 `local` 或 `server`，同一会话不混用游标；同步完成不会切换来源或重置游标。
- 更早消息按来源读取同一路径；合并统一按 `messageId` 去重并复用排序，保留本地 `sending/failed` 状态。
- 同步事件使用 250ms 窗口节流，读取本地最新一页合并，不触碰分页状态；本地 IPC 无取消能力，用请求序号丢弃过期响应。
- 服务端不可达时回退已有本地记录（离线可读已同步范围）。

### 2.7 其他已完成项

- 每个好友独立草稿 + 2000 字上限（客户端 `maxLength` + 提交校验，服务端同样校验）。
- 认证接口限流、NSIS 安装向导、`docs/AUTO_UPDATE_TESTING.md`、`scripts/` 下的假更新服务器与打包测试脚本。
- 本地 SQLite 数据库、同步、前端读取的完整链路，均做过打包态 CDP 验证。

### 2.8 会话列表、通讯录与未读提醒（已完成并验收）

**导航与三栏结构**

- 主界面固定三栏：左侧 64px 导航条（#F2F2F7）、中间 280px 列表（#FFFFFF）、右侧聊天区自适应（#F5F5F7）。
- 导航条两个图标入口：「消息」（会话列表）与「联系人」（通讯录），仅图标 24px、点击区 44×44，选中 #E8F1FF/#007AFF。
- 中间栏顶部是统一搜索框 +「＋」按钮，两个视图共用同一个头部（切换时位置尺寸不变、列表不跳动）；搜索只匹配当前好友昵称，结果下拉，点击即切到「消息」并打开/创建会话；「＋」复用添加好友流程（好友申请制落地后需改成「发起申请」）。
- 会话列表：头像 40px + 昵称 + 最近一条消息摘要（单行截断）+ 时间；排序为「有消息按最后消息时间倒序，无消息按 `last_opened_at_us` 倒序」；同一好友只有一条。
- 通讯录：字母分组（A–Z，`#` 收尾），拼音分组用内置 `Intl.Collator('zh-Hans-CN-u-co-pinyin')` 与边界字二分，无新增依赖；右侧字母索引只显示实际存在的分组；单击仅选中，双击条目打开聊天（旧版是双击头像），800ms 防重入保证不会重复建会话。

**未读提醒**

- 通用 Badge 组件：数字模式与纯红点模式；`count<=0` 不渲染、1–99 原样、>99 显示 `99+`；宽度自适应、红底白字。
- 计数依据是本地 SQLite 消息行的 `is_unread` 标记（**不是**单独计数器表）：跟随 `(user_id, message_id)` 主键与 `ON CONFLICT DO NOTHING` 去重，重复推送/重连/重同步天然不会重复计数，重启后直接由消息行恢复。
- 计入规则：只计收到的对方消息；实时消息在 `document.hasFocus() && 当前会话 === 该会话` 时不标未读；落库时还要求消息时间晚于该会话 `last_opened_at_us`，避免「先按服务端分页看过、后台同步再补写」把已读历史重新计为未读。
- 清除规则：进入某个会话、或窗口重新获得焦点且该会话正打开时，只清该会话；仅切到「消息」入口不清；首次全量同步（无游标）视为历史不计未读，增量同步（有游标）计入离线消息。
- 导航栏消息图标上显示总未读数，0 时隐藏。

### 2.9 主界面 UI 改造第一阶段（已完成并验收）

- 左侧导航顶部由文字「永夜」改为当前用户占位头像（40px 圆形 SVG），在线状态绿点改到头像右下角（10px、2px #F2F2F7 描边，online/pending/offline 三态）；中栏底部原账户模块（头像/昵称/退出登录）已删除。
- 导航条底部新增三点菜单按钮，弹出 128px 宽 iOS 风格菜单（`mousedown` 外部、Esc、窗口失焦均关闭），菜单项由 `railMenuItems` 数组驱动，当前只有「退出登录」。
- 主窗口改为 Electron 原生覆盖式标题栏：`titleBarStyle: 'hidden'` + `titleBarOverlay`（40px、`#F2F2F7`、符号色 `#1D1D1F`）；界面不再显示应用图标和「永夜」文字，但最小化/最大化-还原/关闭仍由系统绘制，窗口可拖动（`.window-titlebar` 设 `-webkit-app-region: drag`）并可边缘缩放（`WS_THICKFRAME`）。
- 系统托盘：用 `resources/icon.png` 生成 16px 托盘图标，tooltip「永夜」；单击/双击恢复并聚焦主窗口；右键弹出原生菜单「退出程序」。关闭按钮拦截为 `hide()`，`window-all-closed` 只在 `isQuitting` 时退出，避免隐藏后被回收；窗口与托盘均为单例，不会重复创建。
- 窗口尺寸三态未变：登录 440×480、注册 440×560、聊天 900×670（无边框后即客户区尺寸），切换仍走 `window:set-layout` IPC。

### 2.10 开发环境启动脚本（已完成）

- 桌面脚本 `C:\Users\Windows\OneDrive\桌面\永夜开发版一键启动.bat`（桌面被 OneDrive 重定向，路径以实际为准；GBK + CRLF）。
- 流程：查 3000 端口 → 自家服务端则复用，空闲则新窗口 `cd server && npm run dev`，被其它程序占用则提示并退出（不杀进程）→ 轮询 `/health` 最多 90s → 新窗口 `npm run dev` 启动 Electron 开发版；服务端与客户端各占一个 `cmd /k` 窗口保留日志。
- 关键坑：从批处理启动 Electron 前必须真正删除 `ELECTRON_RUN_AS_NODE`，用 `set ELECTRON_RUN_AS_NODE=&&`；写成 `set VAR= ` 会留下空格值，Electron 仍按 Node 模式运行并报 `TypeError`。

### 2.11 会话云端化 A1–A3（已正式完成，2026-11-25）

**分阶段概览**

- **A1**：新增 `user_conversations`（迁移 `0007_user_conversations.sql`），`(user_id, peer_id)` 复合主键；字段含置顶/免打扰/隐藏、最近消息时间与 ID、最近活动时间、打开/已读位置、`version` 乐观并发字段。不设 `user_id <> peer_id`、不依赖 `friendships`、不给最近消息字段加外键；从 `messages` 回填双方各一条（自我一条），重复执行不覆盖已有状态。
- **A2**：`sendMessage` 在消息事务内维护双方（自我一条）会话；消息排序用用户对级 advisory lock（`userPairLock.ts`）+ `clock_timestamp()`，保证并发双向发送的 `(created_at,id)` 单调；新增打开会话与状态更新接口（`.version` 乐观并发，自我会话不允许开免打扰）；删除好友改为同事务清理双方关系、消息与会话。
- **A3**：服务端已读位置与未读统计（A3-1），客户端接入（A3-2），打包态验收通过。

**A3-1 服务端已读位置与未读统计**

- `GET /api/conversations` 每个会话返回 `unreadCount`，响应返回 `unreadTotal`（当前用户可见会话之和）。
- 未读定义：`receiver_id = 当前用户 AND sender_id = 对方` 且 `(created_at, id)` 严格大于 `(last_read_at, last_read_message_id)`；未读位置用 PostgreSQL 聚合计算，不新增 `unread_count` 计数器；自我会话恒为 0；免打扰不影响未读。
- `POST /api/conversations/:peerId/read`，body `{ lastReadMessageId }`：事务内先获取与消息发送相同的 `userPairLock`，校验消息属于该用户对，再用数据库中的真实 `created_at` 与消息 ID 成对推进 `last_read_at` / `last_read_message_id`；只允许前进，重复提交同一位置不改变状态；同事务重新计算并返回该会话最新未读数。
- 关键教训：不能用客户端时间或 JS `Date` 作为已读时间参数（毫秒精度会截断 PostgreSQL 的微秒），否则同一时间戳附近的消息会被误判；实现改为在 `UPDATE ... FROM messages` 中直接引用数据库 `created_at`。
- 验证：41 项覆盖未读增减、自己发送不计、标记旧位置不回退、重复提交幂等、同时间戳靠 ID 区分、免打扰不影响、隐藏会话可读可算、自我聊天、404/400/401、并发标记与发送结果一致。

**A3-2 客户端接入**

- 新增 `src/renderer/src/api/conversations.ts`：`getConversations()`、`markConversationReadOnServer()`。
- `ChatScreen.tsx` 新增服务端未读状态（`serverUnread` / `serverUnreadTotal` / `serverUnreadReady`）；会话行头像显示未读角标，导航栏总数改用服务端 `unreadTotal`，接口失败时回退本地统计。
- 已读推进 `reportReadIfLatest()`：仅当窗口有焦点、列表接近底部（48px 阈值）、最新消息含服务端 ID、且非自我聊天时上报最后一条消息 ID；打开会话不再无条件清未读；滚动到底、当前会话收到新消息、窗口重新聚焦时触发；同一会话串行化上报并忽略乱序旧响应。

**打包态验收（通过）**

- 用 `VITE_API_BASE_URL=http://localhost:3000 npm run build:unpack` 产物 + 真实 API/PostgreSQL 验收：会话角标与导航总数、读到最新后清除、历史位置不提前已读、底部新消息自动已读、切换会话/失焦/重新聚焦、自我聊天零未读。
- 修复两个实际缺陷：
  1. **未读总数漂移**：原实现按“已读前后差值”扣减总数，同一会话连续来消息时会被反复扣减到 0。改为各会话未读求和，并对同一会话串行化上报、忽略乱序旧响应。
  2. **历史位置被强制滚到底并误标已读**：消息列表副作用在每次消息变化时无条件 `scrollTop = scrollHeight`。改为记录“是否跟随底部”，只有切换会话或本就在底部时才自动滚底。
- 验收后已停止应用与服务、删除临时 profile/脚本，数据库恢复为验收前状态（`messages=6`、`user_conversations=3`、已读位置为空）。

**修改文件（A3）**

- 服务端：`server/src/services/conversationService.ts`、`server/src/controllers/conversationController.ts`、`server/src/routes/conversationRoutes.ts`（A3-1；`userPairLock.ts` 为 A2 引入、A3-1 复用）。
- 客户端：`src/renderer/src/api/conversations.ts`（新增）、`src/renderer/src/components/ChatScreen.tsx`。
- 迁移：`database/migrations/0007_user_conversations.sql`（A1 已执行）。

---

## 3. 关键设计决策与产品规则

### 3.1 认证与会话

- 密码只存 Argon2id 哈希；JWT 固定 HS256，校验 `sub` 为数字；不信任任何客户端传入的 userId。
- Access Token 短期（900 秒）+ Refresh Token 轮换；Access Token 无状态，登出后最长 15 分钟内仍有效（已知限制）。
- 登录态存 sessionStorage，不写 localStorage；自动登录凭证必须经 `safeStorage` 加密，不可用时拒绝保存并提示用户取消勾选。
- IPC 一律校验 sender 来源，只暴露 invoke 包装，不向渲染进程暴露 `ipcRenderer`。

### 3.2 消息与好友

- 好友关系是双向记录；删除只删关系，历史消息保留。
- 历史消息权限 = 当前用户是参与者，不要求仍是好友；发送新消息要求当前是好友。
- 消息先落库、提交成功才 ACK/推送；推送失败不回滚；重复 `messageId` 幂等。
- 服务端保留期 30 天：读取过滤 + 每小时清理；删除过期消息不影响客户端本地记录。
- 注意：A2 起「删除好友」改为同事务删除双方 `friendships`、双方 `messages` 与双方 `user_conversations`（好友申请记录保留），与本节旧规则“删除只删关系、历史保留”不同；删除聊天（仅隐藏会话）仍不删消息。

### 3.3 在线与连接

- 单账号单连接，新连接替换旧连接；被踢客户端必须提示并停止重连，避免两实例互踢。
- 不做上下线广播，只提供快照 + 30 秒轮询。

### 3.4 本地记录

- 本地 SQLite 是读缓存，不是权威源；写入失败只告警，不影响聊天。
- 本地分页只用于“该会话同步已完成”的情况；同步未完成必须走服务端，避免游标落在历史中段导致遗漏。
- 本地容量清理按时间淘汰，不做按会话删除；清理后不重新下载旧消息。

### 3.5 生产与更新

- 生产页面必须走 `app://` 自定义协议，禁止 `file://`；CSP 与 CORS 都必须显式白名单。
- 自动更新 fail-closed：更新检查未通过不得进入登录页；不提供关闭开关。
- 安装包未签名；正式发布前需代码签名与真实更新源。

### 3.6 会话列表、未读与界面壳

- 会话条目独立建表 `chat_entries`，不复用 `messages` 的隐式分组：需要记录「打开过」时间，且要支持「还没有消息的会话」。
- 未读不做计数列，直接给消息行打 `is_unread`：幂等、重连、重启都与消息本身一致，不需要额外的对账逻辑。
- 聊天列表的「最近一条消息」用窗口函数在查询时从 `messages` 取，**不冗余存储消息内容**（用户明确要求，避免双写不一致）。
- 中文拼音排序不引入第三方拼音库：用 `Intl.Collator('zh-Hans-CN-u-co-pinyin')` 与 23 个边界字二分归组；代价是多音字按 ICU 默认读音（曾→C、单→D、解→J），已在代码注释与验收报告中说明。
- 桌面壳采用 Electron 原生 `titleBarOverlay`，不自己画窗口按钮：保留系统的最大化/还原、贴边、双击标题条、触控缩放语义，减少平台差异。
- 托盘菜单不用 `tray.setContextMenu`，改为 `right-click` 时手动 `popUpContextMenu`：Windows 上设置 contextMenu 会让左键单击也弹菜单，破坏「左键恢复窗口」。
- 「退出登录」与「退出程序」是两个入口、两套逻辑：前者只清会话（回登录页、窗口缩到 440×480），后者才 `app.quit()`。

### 3.7 已放弃 / 不采用

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 多设备同时在线 / 多 Socket 并发 | 放弃 | 产品规定单账号单连接 |
| 好友上下线广播、弹窗通知 | 放弃 | 只做快照与绿点 |
| 用 Socket.IO 替代 REST 历史 | 不采用 | 分页/可恢复查询更适合 REST |
| conversations 表（消息侧） | 不需要 | 1:1 消息由 sender/receiver 确定；会话入口单独用 `chat_entries` |
| 在 `chat_entries` 上维护未读计数列 | 不采用 | 与消息幂等难对齐，改用消息行 `is_unread` |
| 先推送再写库 | 禁止 | 必须以数据库提交为成功标准 |
| 引入拼音 npm 包 | 不采用 | 内置 ICU Collator 已够用，避免新增依赖 |
| `tray.setContextMenu` | 不采用 | Windows 左键也会弹菜单 |
| Redis adapter / 多实例 | 暂不做 | 当前单实例 |
| 生产 `file://` 方案 | 已由自定义协议替代 | 已实现 `app://mychatapp` |
| 群聊、撤回、已读、附件、离线推送 | 不在范围 | 产品明确排除；已读仅做“已读位置/未读数”，不做已读回执 UI |

### 3.8 会话云端化与已读

- 未读用查询聚合，不维护计数器：避免与消息幂等、删除、保留期清理产生对账问题。
- 已读位置用 `(last_read_at, last_read_message_id)` 二元组：只比时间会在同一时间戳下丢消息，只比 ID 又与消息表排序不一致。
- 已读推进与消息发送共用 `userPairLock`：同一用户对串行化，不同用户对互不阻塞。
- 消息时间统一取 `clock_timestamp()`：`CURRENT_TIMESTAMP` 是事务开始时间，长事务会打乱顺序。
- 客户端仍以本地 SQLite 管理列表与置顶/免打扰/删除；服务端只承接消息、会话元数据与已读/未读，避免一次性切换权威源。

---

## 4. 完成状态与已知限制

### 4.1 已完成并验收

- 注册/登录/刷新/登出、自动登录与凭证安全存储、墓碑与并发锁
- 好友增删查、一对一消息（幂等/事务/ACK/实时推送）、历史分页与排序精度
- 在线状态、连接状态提示、同账号踢下线提示与凭证精确清理
- 自定义 Protocol、CSP、CORS、Windows 安装包、NSIS 目录选择
- 认证接口限流、每好友草稿与长度限制
- 自动更新代码与测试脚本（打包测试模式已通过）
- SQLite 本地记录：存储、容量清理、增量同步、本地优先读取、同步并发修复
- 三栏主界面、会话列表（`chat_entries`）、通讯录拼音分组与字母索引、搜索框与「＋」入口、双击打开会话
- 消息未读提醒：`is_unread` 持久化、按会话清除、前台查看不计数、离线增量计入、99+ 角标
- 会话云端化 A1–A3：`user_conversations`、发送事务维护会话、打开/状态接口、服务端已读位置与未读统计、客户端未读角标与已读上报；A3-2 已通过打包态验收
- schema v4 迁移顺序修复（旧库免 `no such column`、新库一次建好、存量消息保留）
- 主界面 UI 改造第一阶段：导航头像+在线点、底部菜单、无边框覆盖式标题栏、系统托盘与关闭即隐藏
- 开发版一键启动脚本（端口复用、健康检查、`ELECTRON_RUN_AS_NODE` 处理）

### 4.2 已有实现但未做完整验收

- 真实 HTTPS 更新源的「下载 → 静默安装 → 重启 → 再次检查」全链路（仅用同版本假源验证到“已是最新版本”）。
- 正式安装包（新版）安装/卸载流程；当前 `dist/mychatapp-1.0.0-setup.exe` 是早于自动更新功能的旧产物，且未包含后续所有 UI/未读改动。
- 多实例/多进程并发场景（仅做过墓碑锁的双实例验证）。
- UI 改造第一阶段只做了针对性验证（关闭隐藏、托盘恢复、托盘退出、退出登录、尺寸三态、静态检查与打包构建），未做长时间驻留、多显示器/不同缩放比例、跨 DPI 拖动等场景。
- A3-2 的已读状态无跨设备实时同步；客户端未读展示依赖进入页面/聚焦/收到消息时刷新。

### 4.3 已知限制（MVP 阶段接受，暂不处理）

1. 自动更新依赖真实 HTTPS 源、代码签名与 `latest.yml`/安装包/blockmap 上传；当前 `publish.url` 为占位地址。
2. `dist/win-unpacked` 是本地测试构建（CSP 指向 `http://localhost:3000`），正式发布必须用真实 `VITE_API_BASE_URL` 重建。
3. Access Token 无状态，登出后最长 15 分钟仍有效；登出撤销 Refresh Token 为尽力而为（立即杀进程可能未送达）。
4. 未勾选自动登录时异常退出，服务端临时 Refresh Token 会残留至 24 小时过期。
5. 在线状态最多约 30 秒延迟（轮询）；不做上下线广播。
6. 限流为单进程内存实现：重启清零、多实例不共享；共享出口 IP 会互相影响；反代后需调整 `trust proxy` 与取 IP 方式。
7. 在线映射与限流均不跨进程；多实例部署需 Redis/粘性会话（当前不做）。
8. 本地 SQLite 清理按时间全局淘汰，不区分账号/会话；被清理的历史无法从本地恢复（服务端仍在保留期内可通过重新同步补齐）。
9. 本地消息只来自实时收发与服务端增量同步；本地容量清理后不会主动回补。
10. 本地同步只在登录后触发一次，运行期间新消息由实时通道写入；断线重连的历史补齐仍走“每好友最近 30 条 + 向上分页”。
11. 双开同一 userData 时两个进程的凭证写入仍是后写覆盖（已通过墓碑与精确清理缓解，未做跨进程文件锁全覆盖）。
12. 安装包未签名；Windows SmartScreen 可能拦截。
13. 无自动化测试入库；验证依赖临时脚本 + 打包产物 CDP 驱动。
14. 托盘/任务栏图标仍是 Electron 默认图标（`resources/icon.png`、`build/icon.png` 本身就是默认资源）；替换品牌图标只需换这三个文件，无需改代码。
15. 40px 标题条固定 `#F2F2F7`，在登录页与白色联系人栏上方有极浅色带边界，已确认接受，不安排优化。
16. 关闭主窗口只是隐藏，必须通过托盘「退出程序」结束进程；暂无「开机自启」「启动即最小化」等托盘选项。
17. 中文分组的多音字按 ICU 默认读音（曾→C、单→D、解→J），不做人工多音字表。
18. 长时间反复登录会在服务端累积 `refresh_tokens` 历史行（当前 131 条），只影响本地测试库，未做定期清理。
19. 会话置顶/免打扰/删除聊天仍以客户端 SQLite 为权威；服务端 `user_conversations` 已有对应字段，但尚未作为客户端会话列表的数据源。
20. 已读位置不做 Socket 广播，多端/多会话的未读数刷新不实时；已读判定采用“窗口有焦点 + 距底部 48px”的近似规则。
21. 隐藏会话（删除聊天）默认不在 `GET /api/conversations` 返回，因此不计入客户端未读角标；服务端未读接口失败时客户端回退本地统计，可能短暂不一致。

### 4.4 联系人与好友管理改造（已完成）

已按批次落地的范围：

1. 联系人行去掉常驻「×」，改为右键菜单：发送消息 / 标为星标（或取消星标）/ 删除好友。
2. 删除好友前二次确认；保留「删好友不删历史消息」的规则。
3. 星标联系人置顶，其余仍按 A–Z 拼音分组。
4. 中间栏顶部新增「新的朋友」模块。
5. 添加好友改为申请制：发起申请 → 接收方同意 → 双方才建立关系。
6. 联系人列表增加「自己」入口，支持与自己聊天。
7. 整行双击进入聊天（不再要求双击头像）。

当前实际：好友申请（含 30 天过期）、星标（`friendships` 字段，服务端权威）、自我聊天（服务端允许自我消息，本地与服务端历史均可查）、会话置顶/免打扰/删除聊天、任务栏闪烁提醒、会话云端化均已上线；原计划中的“验证消息 / 个人资料页 / 备注”仍未做。

---

## 5. 测试与验收方式

### 5.1 固定测试账号

长期保留，禁止删除：

| 用户名 | 昵称 | 用途 |
| --- | --- | --- |
| `test_alice` | 测试用户 A | 主要发送方 |
| `test_bob` | 测试用户 B | 主要接收方 |
| `test_charlie` | 测试用户 C | 次要接收方（与 Alice 已互为好友，用于多会话/未读/分组验证） |
| `test_david` | 测试用户 D | 无好友，用于加好友、好友申请、删除验证 |

- 当前实际关系：Alice ↔ Bob、Alice ↔ Charlie 双向好友；David 无好友。
- 注意：`db:seed-test-users` 只会建 Alice ↔ Bob（`ON CONFLICT DO NOTHING`）；Alice ↔ Charlie 是手工加好友留下的，换到全新库时需自己补一条关系（或临时通过接口加）。
- 密码、数据管理规则见 `database/TEST_ACCOUNTS.md`（仅本地开发使用，**不要写入正式环境**）。
- 初始化：`npm run db:seed-test-users`（同时处理 `mychatapp` 与 `mychatapp_test`，可重复执行）。

### 5.2 两个数据库

- `mychatapp`：手动测试 / Electron 联调。
- `mychatapp_test`：自动化与打包态测试优先使用。

### 5.3 验证方式（按风险选择，不做无意义的全量回归）

工作方式（2026-11-24 需求方确认）：

- **只做最小必要验证**：实现完成后自测关键路径即可，完整回归留到阶段结束进入下一阶段前统一做。
- **报告不用截图**：结论用文字 + 关键数值（尺寸、class/样式、进程/端口状态）表达；不再往仓库或桌面保存截图。
- **不要干扰使用者**：验证优先用应用自身 CDP（`Runtime.evaluate` / `Page.captureScreenshot`）、进程与端口检查；不要主动最小化/移动用户窗口，不要接管鼠标键盘；必须人工确认的（托盘、系统按钮）先问是否方便。

- 静态检查：`npm run typecheck`、`npm run lint`；服务端 `npm run typecheck`、`npm run build`。
- 打包态验证：`VITE_API_BASE_URL=http://localhost:3000 npm run build:unpack`（= typecheck + electron-vite build + electron-builder --dir），用 `dist/win-unpacked/mychatapp.exe --user-data-dir=<临时目录> --remote-debugging-port=<端口>` 启动，通过 CDP 驱动 UI。
  - 本机限制：从 DSH 的 bash 直接启动 Electron 会崩（`0x80000003`），需通过 `explorer.exe <某个.cmd>` 启动以继承用户环境；验证结束记得停进程、删临时 profile。
- 自动更新：用 `npm run test:packaged`（假更新服务器 + 独立 userData），详见 `docs/AUTO_UPDATE_TESTING.md`。
- 数据清理：测试消息按 `id` 或精确 `content` 删除；**不要用宽泛 DELETE**，也不要清空四个固定测试账号。

### 5.4 关键回归点（改到相关模块时检查）

- 删除好友后：不能发送新消息、历史仍可查、重新添加后历史仍可见。
- 旧 `messageId` 重试仍幂等，不产生重复记录。
- 单账号新连接必须踢掉旧连接；被踢端提示并清理凭证。
- 自动登录：勾选后可重启自动登录，登出后必须失效。
- 本地记录：同步未完成时不得使用本地游标；同步完成后新会话优先本地；分页不混用来源。
- 未读：重复推送不重复计数；分页加载历史不增加未读；前台查看当前会话不计；重启后数量不变；`99+` 截断。
- 服务端未读/已读：收到消息后 `unreadCount` 增加；自己发送不增加；标记旧位置不回退；重复标记幂等；同时间戳靠 ID 区分；自我会话恒 0；删除聊天（隐藏）不影响消息未读，但默认不计入未读列表。
- 会话列表：同一好友只有一条；删除好友后入口隐藏但 `chat_entries` 保留；重新加好友后恢复。
- 桌面壳：关闭=隐藏（进程存活）、托盘单击=恢复、托盘右键「退出程序」=进程退出；退出登录≠退出程序。
- 本地库迁移：旧 `user_version` 升级后数据不丢、索引能建、IPC 不报错。

---

## 6. 开发规范（当前阶段默认遵守）

1. **MVP 优先**：以可靠、可用为目标；不扩需求、不顺手加功能、不做非必要重构；已验证功能不反复优化。
2. **问题优先级**：按发生概率 × 影响 × 阶段必要性判断；低概率边界问题记为已知限制，不为理论完美引入复杂机制。
3. **验证从简**：只做与改动直接相关的基础验证，不重复完整回归；核心业务/安全/数据库等高风险改动才按需加验证；阶段验收时再综合检查。
4. **任务执行**：严格限定当前任务范围，最小改动，不动无关文件/配置；不新增依赖、不换技术栈；优化建议只写进报告不自行实施；完成即报告并等待下一项任务。
5. **协作分工**：ChatGPT 负责需求、方案、拆分与审查；DSH 负责读代码、实施、必要验证与报告；充分利用本文档与前序验收结果，避免重复检查。
6. **报告内容**：修改内容、必要验证结果、已知限制、未完成事项；不堆砌无关测试细节。
7. **报告不附图**：不再在报告里贴截图，也不往仓库/桌面保存验证截图；需要呈现结果时用文字和数值。
8. **自验即可**：功能实现后由 DSH 自行确认（静态检查 + 关键路径探测），不必每次都让需求方复验；完整验证统到阶段收尾。
9. **不干扰使用者**：需求方可能同时在用这台电脑——不要主动最小化/移动其窗口、不要抢焦点、不要模拟鼠标键盘；验证尽量走应用内部通道（CDP、DOM、IPC）与只读检查；必须人工确认时先询问。

---

## 7. 当前运行状态与环境事实

- 本地服务均已关闭：3000（后端）、3999（假更新服务器）、5173、9222 无监听；无 `mychatapp.exe` 进程。
- 服务端库 `mychatapp`：4 个固定账号（id 62–65）、4 条好友关系（Alice↔Bob、Alice↔Charlie 双向）、`messages=6`（11/20–11/23 样本与 Alice 自我记录；A2/A3 验收产生的测试消息已清理）、`user_conversations=3`、`friend_requests=0`、`refresh_tokens=131`（多轮登录累积，未清理）；迁移已执行到 `0007_user_conversations.sql`。
- 客户端本地库 `C:\Users\Windows\AppData\Roaming\mychatapp\data\messages.db`：`user_version=6`、`messages=38`、`chat_entries=3`、`sync_cursors=2`。
- `screenshots/` 目录仍在（01–22，历史阶段产物，git 未跟踪）；按新规则后续不再新增。
- 工作区**未提交任何 git commit**：大量已修改文件（`src/main/index.ts`、`src/renderer/src/{App.tsx,components/ChatScreen.tsx,assets/main.css}` 等）与未跟踪文件（`src/main/localMessageStore.ts`、`localMessages/`、`contacts/`、`components/Badge.tsx`、`shared/windowLayout.ts`、`docs/`、`scripts/`、`database/migrations/0003_message_retention.sql`、`screenshots/` 等）都还在工作区；接手后先 `git status`，不要误删或回滚。
- 开发态 Electron 在本机直接启动可能崩溃（退出码 `0x80000003`，最小示例同样崩溃），属本机环境问题；打包后的 exe 可正常运行，验证更新/打包相关功能请用打包测试模式或桌面一键启动脚本。
- DSH 会话 shell 默认 `ELECTRON_RUN_AS_NODE=1`，启动 Electron 应用需 `env -u ELECTRON_RUN_AS_NODE`。
- 正式发布前必须处理：真实 HTTPS API 地址、真实更新源、代码签名、重新构建 NSIS 安装包。

---

## 8. 交接提醒

- 不要删除四个固定测试账号，不要用宽泛 SQL 清理“所有用户/所有消息”。
- 自动化测试优先 `mychatapp_test`；手动测试用 `mychatapp`。
- 修改消息/好友逻辑时必须同时验证：删除好友后不能发新消息、历史仍可查、旧 messageId 仍幂等。
- 修改 Socket 认证/连接管理时注意单连接替换、StrictMode、被踢提示。
- 修改本地记录/同步时必须验证：同步未完成走服务端、完成后本地优先、分页来源不混用、去重与排序不变。
- 修改认证/凭证时必须验证：自动登录、登出撤销、凭证文件加密、墓碑不复活旧 Token。
- 修改本地库 schema 时：**先补列再建索引**，并用「旧版本库 + 新版本库 + 空目录」三种起点各启动一次，确认 `user_version`、数据量与 IPC 都正常。
- 修改导航/会话列表/未读时：注意 `chat_entries` 的 `(user_id, peer_id)` 唯一键、`last_opened_at_us` 同时参与排序与未读判定，改任何一个都会影响另一方。
- 改动主进程窗口/托盘时：保持窗口与托盘单例、`isQuitting` 语义、`close` 拦截与 `window-all-closed` 的组合逻辑；不要用 `tray.setContextMenu`（会让左键也弹菜单）。
- 「退出登录」与「退出程序」是两件事，任何改动都不要让其一取代另一。
- `HANDOFF.md` 已从打包内容中排除（`electron-builder.yml` 的 `files`），不会进入安装包。

---

## 9. 最近阶段新增记录摘要

- 未读提醒 + 通用 Badge 完成并验收；schema v4 迁移缺陷已修复，线上使用中的旧库（24 条消息）已验证无损升级。
- 会话列表（`chat_entries`）、通讯录拼音分组、搜索框与「＋」入口完成并验收。
- 主界面 UI 改造第一阶段完成并验收：导航头像+在线点、底部菜单、无边框覆盖式标题栏、系统托盘、关闭即隐藏。
- 桌面一键启动脚本已交付（含 `ELECTRON_RUN_AS_NODE` 处理）。
- 下一阶段（联系人与好友管理改造）需求确认；后续已按批次完成，见 4.4 与 2.11。

### 2026-11-25（会话云端化 A3：已读位置、未读统计与客户端接入）

- 服务端已读/未读完成（A3-1）：`GET /api/conversations` 返回每会话 `unreadCount` 与 `unreadTotal`（按 `(created_at,id)` 聚合，无计数器）；`POST /api/conversations/:peerId/read` 在 `userPairLock` 内校验消息归属、只许前进、同事务返回最新未读；自我会话恒 0。验证 41 项通过。
- 客户端接入完成（A3-2）：新增 `api/conversations.ts`；`ChatScreen.tsx` 接入服务端未读角标/导航总数、`reportReadIfLatest()` 按焦点 + 48px 近底上报；接口失败回退本地未读。
- 打包态验收通过：真实 exe + 真实服务端验收六个场景（角标/总数、读到最新清除、历史位置不误标、底部新消息自动已读、切换/失焦/聚焦、自我聊天零未读）。
- 验收中修复两个实际缺陷：① 未读总数按差值扣减导致漂移 → 改为各会话求和 + 串行化 + 乱序保护；② 新消息强制滚到底导致误标已读 → 改为“跟随底部”判定，仅切换会话或本在底部时自动滚底。
- 修改文件：`server/src/{services,controllers,routes}/conversation*`、`src/renderer/src/api/conversations.ts`、`src/renderer/src/components/ChatScreen.tsx`。
