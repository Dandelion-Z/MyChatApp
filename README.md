# 永夜（Polar Night）

永夜是一个桌面端即时通讯应用：Electron + React 桌面客户端，Node.js/Express + Socket.IO 服务端，PostgreSQL 存储云端数据，客户端本地使用 SQLite 做消息缓存。

当前处于 **MVP 封闭测试准备阶段**：注册登录、好友申请与备注、单聊与自我备忘、消息未读/已读、会话置顶/免打扰/删除、个人资料与头像、等级与活跃积分、修改密码等功能已实现；群聊、图片/文件消息、消息撤回、离线推送和端到端加密尚未实现。当前仅以 Windows 桌面端为验收目标，macOS/Linux 构建未做完整验证。

完整的架构、数据库结构、接口清单、测试基线与已知限制见 [HANDOFF.md](HANDOFF.md)。

## 环境要求

- Node.js（本项目开发环境为 Node 26；Electron 44 内置 Node 22）
- PostgreSQL 18（开发环境，本地默认 `localhost:5432`）
- Windows 10/11（桌面端打包与验收环境）

## 安装

```bash
npm install
cd server && npm install
```

## 启动

先准备服务端环境变量：

```bash
cd server
cp .env.example .env
# 编辑 .env：DATABASE_URL、JWT_SECRET 等
```

初始化数据库并启动服务端（默认只监听 `127.0.0.1:3000`）：

```bash
# 在项目根目录
DATABASE_URL='postgresql://user:password@127.0.0.1:5432/mychatapp' npm run db:migrate

cd server
npm run dev
```

启动桌面客户端（开发模式，Vite + Electron）：

```bash
# 在项目根目录
npm run dev
```

## 常用命令

| 命令                    | 说明                                              |
| ----------------------- | ------------------------------------------------- |
| `npm run dev`           | 启动开发版桌面客户端                              |
| `npm run build`         | 类型检查并构建 Electron 产物                      |
| `npm run build:unpack`  | 构建 Windows 免安装目录（`dist/win-unpacked`）    |
| `npm run build:win`     | 构建 Windows 安装包                               |
| `npm run typecheck`     | 客户端 TypeScript 检查                            |
| `npm run lint`          | ESLint 检查                                       |
| `npm run db:migrate`    | 执行 PostgreSQL 迁移（需显式提供 `DATABASE_URL`） |
| `npm run test:qa`       | 一键接口回归（需要 `QA_DATABASE_URL`，见下）      |
| `npm run test:packaged` | 打包态自动更新冒烟测试                            |

服务端自身命令在 `server/` 目录：`npm run dev`、`npm run build`、`npm run typecheck`。

## 一键接口回归

```bash
QA_DATABASE_URL='postgresql://user:password@127.0.0.1:5432/mychatapp_qa' npm run test:qa
```

只接受显式 `QA_DATABASE_URL`，且会校验数据库名必须为 `mychatapp_qa`，不会回退到开发库；测试账号与数据在隔离库中自动清理。GUI 与打包态走查仍需人工完成。覆盖范围与安全规则见 [HANDOFF.md](HANDOFF.md) 第 6 节。

## 文档

- [HANDOFF.md](HANDOFF.md)：架构、数据库、接口、测试与部署要求
- [docs/AUTO_UPDATE_TESTING.md](docs/AUTO_UPDATE_TESTING.md)：自动更新测试流程
- [docs/CLOSED_BETA_TESTER_NOTICE.md](docs/CLOSED_BETA_TESTER_NOTICE.md)：封闭测试须知（含消息加密现状说明）
