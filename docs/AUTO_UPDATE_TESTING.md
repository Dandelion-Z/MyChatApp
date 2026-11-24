# MyChatApp 自动更新测试说明

本文档只回答「怎样测试自动更新」，不涉及发布流程之外的产品功能。三种模式必须区分清楚，否则最常见的现象就是**登录界面不出现**或**登录提示无法连接服务器**。

| 模式             | 启动方式                                                         | `app.isPackaged` | 是否检查更新   | 需要更新源        |
| ---------------- | ---------------------------------------------------------------- | ---------------- | -------------- | ----------------- |
| 开发模式         | `npm run dev`                                                    | `false`          | 否（直接放行） | 不需要            |
| 打包测试模式     | `dist/win-unpacked/mychatapp.exe` + 假更新服务器 + 独立 userData | `true`           | 是             | 本地假更新服务器  |
| 正式安装测试模式 | 安装包安装后的 exe                                               | `true`           | 是             | 真实 HTTPS 更新源 |

> 自动更新是 fail-closed 的：更新检查没通过就不会渲染登录页。这是需求要求的行为，**没有关闭开关**，也不要在测试里加。

---

## 1. 开发模式（日常开发）

```bash
# 终端 1：后端
cd server && npm run dev

# 终端 2：桌面端
npm run dev
```

- `src/main/updater.ts` 在 `!app.isPackaged` 时直接进入 `ready`，不会读取更新地址、不会发网络请求。
- 开发模式不要求 `VITE_API_BASE_URL`，客户端默认使用 `http://localhost:3000`。
- 若开发态 Electron 启动即崩溃（例如退出码 `0x80000003`），这是本机 Electron 环境问题，与更新逻辑无关；用打包测试模式验证更新相关功能。

---

## 2. 打包测试模式（本地假更新服务器）

打包测试用 `win-unpacked` 产物，它 `isPackaged=true`，因此**必须**提供更新源，否则会停在更新门禁。

### 2.1 前置条件

1. 后端与 PostgreSQL 已启动（默认 `http://localhost:3000`，测试库 `mychatapp_test`）。
2. 已安装依赖（`npm install`）。

### 2.2 一键流程（推荐）

```bash
npm run test:packaged
```

脚本 `scripts/test-packaged-update.mjs` 依次执行：

1. 以 `VITE_API_BASE_URL=http://localhost:3000` 执行 `npm run build`；
2. 执行 `electron-builder --dir` 生成 `dist/win-unpacked`；
3. 启动本地假更新服务器 `scripts/fake-update-server.mjs`（默认 `http://127.0.0.1:3999/mychatapp`，返回同版本 `latest.yml`）；
4. 用独立 `--user-data-dir=dist/.update-test-profile` 启动 exe，并注入 `MYCHATAPP_UPDATE_URL`；
5. 应用退出后自动关闭假服务器并清理测试 userData。

常用选项：

```bash
npm run test:packaged -- --skip-build   # 复用已有 dist/win-unpacked
npm run test:packaged -- --smoke        # 启动 8 秒内确认门禁请求了 latest.yml，然后自动退出
npm run test:packaged -- --keep-profile # 保留测试 userData（便于排查）
```

### 2.3 手动分步流程

```bash
# 1) 构建（必须设置 API 地址，否则生产 CSP 只允许 'self'，登录会提示无法连接服务器）
VITE_API_BASE_URL=http://localhost:3000 npm run build
npx electron-builder --dir

# 2) 启动假更新服务器（同版本号 = 无更新）
node scripts/fake-update-server.mjs

# 3) 另开终端启动 exe（Windows PowerShell 示例）
$env:MYCHATAPP_UPDATE_URL="http://127.0.0.1:3999/mychatapp"
.\dist\win-unpacked\mychatapp.exe --user-data-dir=dist\.update-test-profile
```

`MYCHATAPP_UPDATE_URL` 只在本次启动生效，不要写入系统环境变量或注册表。

### 2.4 假更新服务器的行为

`scripts/fake-update-server.mjs`：

- **只按 URL 的 pathname 匹配 `latest.yml`**，忽略 `?noCache=...` 查询参数（这是之前 404 的根因）。
- 默认返回 `package.json` 的版本号，应用应显示「已是最新版本」并进入登录页。
- 环境变量：
  - `FAKE_UPDATE_PORT`：端口，默认 `3999`；
  - `FAKE_UPDATE_VERSION`：返回的版本号，默认当前版本；
  - `FAKE_UPDATE_PATH`：feed 路径前缀，默认 `/mychatapp`；
  - `FAKE_UPDATE_DIR`：可选静态目录。目录下有 `latest.yml` 时原样返回，并同时提供其中列出的安装包/blockmap 下载（用于本地完整更新流程）。
- 支持 `GET`/`HEAD`，其他方法返回 405；未匹配路径返回 404，并在日志中打印请求行。

### 2.5 期望结果

| 场景                             | 期望界面                                           |
| -------------------------------- | -------------------------------------------------- |
| 假服务器返回同版本               | 短暂显示「正在检查更新…」→「已是最新版本」→ 登录页 |
| 假服务器返回更高版本且提供安装包 | 自动下载 → 自动安装并重启 → 重启后再检查 → 登录页  |
| 假服务器未启动 / 地址错误        | 更新门禁停留，显示错误与「重试」，**不出现登录框** |

---

## 3. 正式安装测试模式

正式安装测试验证的是「真实分发链路」，不能用假服务器替代。

### 3.1 前置条件

1. **真实 HTTPS 更新源**（例如 `https://updates.example.com/mychatapp`，不要用 `.invalid`/`example.com` 占位）。
2. 构建时设置真实 API 地址：`VITE_API_BASE_URL=https://chat-api.example.com`。
3. 构建前把 `electron-builder.yml` 的 `publish.url` 改为真实地址，或只依赖运行期 `MYCHATAPP_UPDATE_URL`（安装包内 `app-update.yml` 会写入 `publish.url`）。
4. 新版本安装包必须使用**更高的 `version`**（`package.json`），并生成 `latest.yml`、`*-setup.exe`、`*-setup.exe.blockmap`。
5. 把上述文件上传到更新源同一目录。

### 3.2 步骤

1. 安装**旧版本**安装包（`dist/mychatapp-<旧版本>-setup.exe`），先不要启动。
2. 在更新源上传新版本的 `latest.yml`、`*.exe`、`*.blockmap`。
3. 启动旧版本：
   - 期望：更新门禁 → 「发现新版本」→ 自动下载（显示进度）→ 下载完成后自动静默安装并重启；
   - 重启后再次检查更新 → 确认已是最新 → 进入登录页。
4. 登录并做一次收发消息，确认升级没有破坏 `userData`（自动登录凭证、本地 `messages.db` 仍可用）。
5. 若安装包已签名，验证安装/升级过程没有 SmartScreen 或签名错误。

### 3.3 检查清单

- [ ] 启动旧版本后没有直接进入登录页（先检查更新）
- [ ] 自动下载有进度，且没有弹窗要求确认
- [ ] 下载完成后自动退出并静默安装，随后自动启动新版本
- [ ] 新版本启动后再次检查，确认无更新后才出现登录页
- [ ] 升级后 `userData` 未被清空：自动登录仍可用、本地聊天记录仍在
- [ ] 更新源不可达时停留在门禁并显示错误与「重试」

---

## 4. 常见问题

| 现象                                           | 原因                                                                              | 处理                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 门禁显示「未找到更新配置（app-update.yml）…」  | `electron-builder --dir` 不生成 `app-update.yml`，且未设置 `MYCHATAPP_UPDATE_URL` | 用 `npm run test:packaged` 或手动注入 `MYCHATAPP_UPDATE_URL`     |
| 门禁显示「未配置更新服务器地址（占位地址 …）」 | 打包时 `publish.url` 仍是 `.invalid` 占位                                         | 测试时用 `MYCHATAPP_UPDATE_URL` 覆盖；正式发布前改真实地址并重建 |
| 假服务器返回 404                               | 旧脚本按 `endsWith('latest.yml')` 匹配，被 `?noCache=` 破坏                       | 使用 `scripts/fake-update-server.mjs`（按 pathname 匹配）        |
| 能进登录页但登录提示「无法连接服务器」         | 构建时未设置 `VITE_API_BASE_URL`，生产 CSP 只允许 `'self'`                        | 重新构建并设置 `VITE_API_BASE_URL`                               |
| 开发模式 Electron 直接崩溃                     | 本机 Electron 环境问题（最小示例同样崩溃）                                        | 与更新无关；改用打包测试模式                                     |

---

## 5. 与旧产物的区别

- `dist/win-unpacked` 是**测试构建**：CSP 指向 `http://localhost:3000`，且通常没有 `app-update.yml`，直接双击会被门禁拦住；用 `npm run test:packaged` 启动。
- `dist/mychatapp-1.0.0-setup.exe` 若早于自动更新功能，则不包含更新门禁，不能拿来验证升级流程；正式安装测试必须重新构建安装包。
