# MyChatApp 项目交接记录

> 记录时间：2026-11-22
> 适用版本：第五阶段任务 3 完成时
> 本文用于交接当前目标、已完成进度、关键决策、放弃方案与下一步工作。

---

## 1. 项目目标

构建一个桌面即时通讯应用 MyChatApp：

- 客户端：Electron + React + TypeScript + Vite
- 服务端：Node.js + Express + Socket.IO + PostgreSQL + pg
- 第一版范围：注册/登录、好友管理、一对一实时消息、历史消息
- 明确不做：群聊、好友申请、用户搜索、文件/语音/视频、消息撤回、已读回执、多设备同时在线

当前只开发桌面端，不包含 Web/移动端。

---

## 2. 当前进度

### 已完成

| 模块         | 状态 | 说明                                                                    |
| ------------ | ---- | ----------------------------------------------------------------------- |
| 项目初始化   | ✅   | Electron + React + TS + Vite，服务端独立在 `server/`                    |
| 数据库       | ✅   | users / friendships / messages 三表 + 迁移脚本                          |
| 认证         | ✅   | 注册、登录、Argon2id、JWT HS256、900 秒有效期                           |
| 客户端会话   | ✅   | sessionStorage、AuthContext、requestWithAuth、401 自动登出              |
| 好友列表     | ✅   | 真实 `GET /api/friends`，加载/错误/空状态                               |
| 添加好友     | ✅   | 用户名添加、业务错误提示、成功后刷新并选中                              |
| 删除好友     | ✅   | 二次确认、成功后刷新、消息不受影响                                      |
| Socket 连接  | ✅   | 握手 JWT 认证、Token 到期断开、StrictMode/卸载清理                      |
| 在线状态     | ✅   | 单账号单连接、`presence:get` / `presence:snapshot`、头像绿点、30 秒刷新 |
| 历史消息 API | ✅   | 双向查询、游标分页、微秒精度、删除好友后仍可查                          |
| 消息发送后端 | ✅   | `message:send`、幂等、事务、ACK、`message:new` 推送                     |
| 聊天界面     | ✅   | 历史加载、Socket 发送、ACK 状态、`message:new` 实时合并、失败重发       |
| 固定测试账号 | ✅   | 两个本地数据库均初始化，可重复执行 seed                                 |

### 当前可用能力

- 后端消息链路与客户端聊天界面已全部接通；
- ChatScreen 切换好友时按需加载最近 30 条历史，支持 loading/error/空状态；
- 发送走 `sendChatMessage()`，本地乐观占位（`sending`）→ ACK 成功后用服务端结果替换（`sent`）→ 失败标记 `failed` 并支持“重发”（复用原 `messageId`）；
- 订阅 `message:new`，按 `messageId` 去重合并，实时消息按会话归属到对应好友；
- 刷新后消息从数据库恢复，不再依赖本地内存。

### 尚未实现

- 历史消息向上分页加载更多（服务端游标已具备，UI 未接入）；
- 重连后自动补拉离线期间消息；
- 未读计数/新消息提示。

---

## 3. 关键架构与设计决策

### 认证

- JWT 使用 HS256，`sub` 为用户 ID，有效期 900 秒；
- 客户端 Token 存 `sessionStorage`（键 `mychatapp.auth`），AuthContext 内部保存 tokenRef；
- REST 使用 `requestWithAuth` 注入 Bearer，401 统一登出；
- Socket 握手从 `auth.token` 取 JWT，由服务端验证，身份写入 `socket.data.userId`；
- 任何业务都不得信任客户端传来的 userId。

### 好友

- `friendships` 为双向记录；
- 删除好友只删 `friendships`，不删 `messages`；
- 历史消息权限只要求“当前用户是消息参与者”，不要求当前仍是好友；
- 发送新消息要求当前存在双向好友关系。

### 在线状态

- 第一版规定同一账号只保留最新一个 Socket；
- `Map<userId, socketId>`，新连接替换旧连接；
- 旧连接延迟断开时检查映射归属，不能删除新连接状态；
- **不做上线/离线广播**；
- 客户端通过 `presence:get` 获取在线好友快照，每 30 秒刷新，连接/重连/好友列表刷新时也刷新；
- 好友头像右下角绿点表示在线，不显示其他在线文字。

### 消息

- 客户端生成 UUID 作为 `messageId`；
- 先查 `message_id` 是否已存在，已存在则按幂等返回，不检查好友关系；
- 不存在才校验接收者、双向好友关系；
- 事务中 `FOR SHARE` 锁定好友关系行；
- `INSERT ... ON CONFLICT (message_id) DO NOTHING`，冲突后重新查询校验；
- 数据库提交成功后才 ACK 或推送；
- 推送失败不回滚消息；
- 接收方离线时仍保存，重新连接后通过历史 API 补齐；
- 重复请求不重复推送。

### 历史消息

- `GET /api/messages/:friendId?limit=30&before=<cursor>`
- 只查询当前用户与 friendId 的双向消息；
- 游标使用服务端生成的 PostgreSQL 微秒时间文本，不经过 JS Date；
- 返回时间升序，`nextCursor` 用于加载更早消息。

### 客户端消息状态

- 本地消息模型：`{ messageId, text, createdAt, mine, status, error? }`，按“对方用户 ID”分会话保存；
- 发送前用 `crypto.randomUUID()` 生成 `messageId`，先插入 `sending` 占位，再调用 `sendChatMessage()`；
- ACK 成功：用服务端 `createdAt`/`content` 覆盖本地占位并标记 `sent`；
- ACK 失败/超时/断线：标记 `failed` 并展示原因，重发复用原 `messageId`（服务端幂等）；
- `message:new` 与历史结果都按 `messageId` 合并去重，服务端结果覆盖同 ID 的本地占位；
- 微秒 ISO 时间先截断为毫秒再交给 `Date` 解析，避免解析失败；
- 重新添加好友时会清掉该好友的“已加载历史”标记，切过去后重新从服务端拉取历史，再与本地保留的记录按 `messageId` 合并，因此重新添加后原聊天记录仍可见。

---

## 4. 放弃 / 未采用的方案

以下方案曾讨论或提出，但最终未采用，避免后续重复走弯路：

| 方案                                    | 状态        | 原因                                               |
| --------------------------------------- | ----------- | -------------------------------------------------- |
| 多 Socket 并发 + 多设备同时在线         | ❌ 放弃     | 产品改为第一版单账号单连接，新连接替换旧连接       |
| 好友上线/离线广播、弹窗通知             | ❌ 放弃     | 产品明确改为只靠快照和头像绿点                     |
| 用 Socket.IO 替代 REST 历史消息         | ❌ 不采用   | 历史需要分页/可恢复查询，REST 更合适               |
| 新增 conversations / conversation_id 表 | ❌ 暂不需要 | 1:1 消息可由 sender/receiver 唯一确定              |
| 客户端只本地追加消息、不落库            | ❌ 放弃     | 无法保证可靠性和离线补齐                           |
| 先推送再写库                            | ❌ 禁止     | 必须以数据库提交为成功标准                         |
| 多实例 Redis adapter                    | ❌ 暂不做   | 当前单实例部署，第一版不引入                       |
| 生产环境 `file://` 直接连接方案         | ⏸ 延后      | 需要自定义 Electron Protocol / WSS / CORS 重新设计 |
| 群聊、撤回、已读回执、附件、离线推送    | ❌ 不在范围 | 产品明确排除                                       |

---

## 5. 固定测试账号

长期保留，不要删除：

| 用户名         | 昵称       | 用途                 |
| -------------- | ---------- | -------------------- |
| `test_alice`   | 测试用户 A | 主要发送方           |
| `test_bob`     | 测试用户 B | 主要接收方           |
| `test_charlie` | 测试用户 C | 非好友、权限测试     |
| `test_david`   | 测试用户 D | 额外测试账号，无好友 |

- 固定关系：`test_alice` ↔ `test_bob`；
- `test_alice` 与 `test_charlie` 不是好友；
- `test_david` 无预设好友；
- 测试密码、数据库用途与清理规则见 `database/TEST_ACCOUNTS.md`；
- 密码仅限本地开发，禁止用于正式环境。

初始化：

```bash
npm run db:seed-test-users
```

脚本会同时处理 `mychatapp` 与 `mychatapp_test`，可重复执行，不删除账号/消息，不修改其他用户。

---

## 6. 关键文件

### 客户端

| 文件                                         | 作用                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `src/renderer/src/components/ChatScreen.tsx` | 好友列表、聊天 UI、历史加载、消息发送/重发、添加/删除好友、在线绿点  |
| `src/renderer/src/socket/socketClient.ts`    | Socket 连接管理、在线快照、消息发送/订阅                             |
| `src/renderer/src/api/messages.ts`           | 历史消息查询（游标/limit/AbortSignal）                               |
| `src/renderer/src/api/friends.ts`            | 好友列表/添加/删除                                                   |
| `src/renderer/src/api/client.ts`             | 通用 REST 请求与 ApiError                                    |
| `src/renderer/src/auth/AuthContext.tsx`      | 登录状态、Token、requestWithAuth、登出                       |
| `src/renderer/src/auth/session.ts`           | sessionStorage 会话读写                                      |

### 服务端

| 文件                                          | 作用                                                     |
| --------------------------------------------- | -------------------------------------------------------- |
| `server/src/index.ts`                         | Express/Socket.IO 启动、路由挂载、关闭流程               |
| `server/src/socket/index.ts`                  | Socket JWT 认证、单连接映射、在线快照、消息 handler 注册 |
| `server/src/socket/messageHandler.ts`         | `message:send` 参数校验、ACK、推送                       |
| `server/src/services/messageService.ts`       | 历史查询、发送、幂等、事务、好友校验                     |
| `server/src/controllers/messageController.ts` | 历史消息 HTTP 控制器                                     |
| `server/src/routes/messageRoutes.ts`          | `/api/messages` 路由                                     |
| `server/src/services/friendService.ts`        | 好友业务                                                 |
| `server/src/middleware/authMiddleware.ts`     | REST JWT 认证                                            |

### 数据库与测试数据

| 文件                                          | 作用                       |
| --------------------------------------------- | -------------------------- |
| `database/migrations/0001_initial_schema.sql` | 初始三表与索引             |
| `database/scripts/migrate.ts`                 | 迁移工具                   |
| `database/scripts/seed-test-users.ts`         | 固定账号初始化             |
| `database/TEST_ACCOUNTS.md`                   | 测试账号说明与数据管理规则 |

---

## 7. 本地运行方式

### 启动后端

```bash
cd server
npm run dev
```

默认端口 3000，使用 `server/.env` 中的 `DATABASE_URL`（`mychatapp`）。

### 启动 Electron 客户端

```bash
npm run dev
```

### 数据库迁移

```bash
npm run db:migrate
```

### 固定测试账号

```bash
npm run db:seed-test-users
```

### 工程检查

```bash
npm run typecheck
npm run lint
npm run build

cd server
npm run typecheck
npm run build
```

---

## 8. 当前运行状态

- 开发/测试服务均已关闭；
- 3000/3001/9229/5173/9223 端口均已释放；
- `mychatapp`：4 个固定账号，Alice ↔ Bob 好友关系，消息 0 条；
- `mychatapp_test`：4 个固定账号，Alice ↔ Bob 好友关系，消息 0 条；
- 临时脚本已清理；
- 未遗留测试用户或测试消息。
- 最近一次验收（任务 4：ChatScreen 消息接入）：在 `mychatapp_test` 上完成 20 项接口级检查（发送 ACK、实时推送、幂等重发、历史去重、删除好友后历史可查/发送失败、重新添加后历史可见），全部通过；随后按 `message_id` 精确清理，`messages` 恢复 0 条。

---

## 9. 下一步建议

### 优先级 1：ChatScreen 消息接入 ✅ 已完成

已完成内容：

1. 新增 `api/messages.ts`，调用历史消息 REST；
2. ChatScreen 切换好友时加载历史消息，处理 loading/error/空状态；
3. 发送改用 `sendChatMessage()`，不再本地直接追加；
4. 订阅 `message:new`，按 `messageId` 去重合并；
5. 消息状态：`sending` / `sent` / `failed`（失败可“重发”，复用原 `messageId`）；
6. 保留好友切换隔离、输入框 Enter/IME、滚动行为。

仍未覆盖：删除好友后无法从列表进入该好友的聊天界面（好友已被移除，聊天区自动切走），
因此“历史仍可查”目前只体现在后端 API 层；发送到已删除好友会收到 `NOT_FRIEND`
并显示失败与重发提示。

### 优先级 2：可靠性（下一步）

- ACK 超时/断线后使用同一 `messageId` 重试（客户端已支持手动重发，自动重试未做）；
- 重连后重新拉取最新历史，补齐离线期间消息（当前历史只在首次切换好友时加载）；
- 历史消息向上分页加载（服务端游标已具备，UI 未接入）；
- 失败消息手动重发（已实现，可继续补自动重试）；
- 不自动生成新 messageId（已遵守）。

### 优先级 3：体验

- 未读计数/新消息提示（当前未实现）；
- 消息时间分组、发送中动画；
- 历史加载更多按钮或滚动触发。

### 优先级 4：生产化

- Electron `file://` Origin 与 Socket.IO CORS；
- 自定义 Protocol 或生产 WSS 配置；
- CSP 仅保留实际需要的来源；
- 速率限制、日志脱敏、部署检查。

---

## 10. 已知限制与风险

1. **历史消息只加载最近 30 条，且重连不补拉**：没有“加载更多”入口，更早消息需游标分页接入 UI；Socket 重连后不会自动重新拉取离线期间消息，只依靠下一次切换好友触发。
2. **在线状态有最多约 30 秒延迟**：依赖快照轮询，没有广播。
3. **旧客户端被新连接替换后不会自动重连**：Socket.IO 对 `io server disconnect` 不自动重连；界面不会主动提示。
4. **生产环境来源未解决**：打包后的 `file://` Origin 为 `null`，CORS/CSP/WSS 需要单独设计。
5. **历史 API 对已软删除用户返回 404**：这是当前约定。
6. **无速率限制**：消息发送和在线查询均未做频率限制。
7. **消息长度仅应用层限制**：数据库没有 2000 字符约束。
8. **单实例在线映射**：`Map` 不跨进程，多实例部署需 Redis 或粘性会话。
9. **监控/日志**：服务端日志包含 userId 和 socketId，不含 Token；生产仍需日志规范。

---

## 11. 交接提醒

- 不要删除四个固定测试账号；
- 不要使用宽泛 SQL 清理“所有测试用户/所有消息”；
- 测试前先执行 `npm run db:seed-test-users` 确认账号存在；
- 自动化测试优先使用 `mychatapp_test`；
- 手动 Electron 测试使用 `mychatapp`；
- 修改消息/好友逻辑时必须同时验证：删除好友后不能发新消息、历史仍可查、旧 messageId 重试仍幂等；
- 修改 Socket 认证或连接管理时，注意 StrictMode 和单连接替换规则。
