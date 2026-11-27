# Polar Night（永夜）自动更新测试说明

本文档只回答「怎样测试自动更新」，不涉及发布流程之外的产品功能。三种模式必须区分清楚，否则最常见的现象就是**登录界面不出现**或**登录提示无法连接服务器**。

| 模式             | 启动方式                                                         | `app.isPackaged` | 是否检查更新   | 需要更新源                            |
| ---------------- | ---------------------------------------------------------------- | ---------------- | -------------- | ------------------------------------- |
| 开发模式         | `npm run dev`                                                    | `false`          | 否（直接放行） | 不需要                                |
| 打包测试模式     | `dist/win-unpacked/polarnight.exe` + 假更新服务器 + 独立 userData | `true`           | 是             | 本地假更新服务器（Generic，环境变量） |
| 正式安装测试模式 | 安装包安装后的 exe                                               | `true`           | 是             | GitHub Releases（公开仓库，无 Token） |

> 自动更新是 fail-closed 的：更新检查没通过就不会渲染登录页。这是需求要求的行为，**没有关闭开关**，也不要在测试里加。

---

## 0. 三种更新源的区别（先看这里）

| 用途               | 来源                                                         | 配置位置                                          |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------- |
| 正式版更新         | GitHub Releases（`Dandelion-Z/Polar-Night`，公开仓库）        | `electron-builder.yml` 的 `publish` → 安装包内 `resources/app-update.yml` |
| 本地更新测试       | 本地 Generic 假服务器（`scripts/fake-update-server.mjs`）     | 运行期环境变量 `POLARNIGHT_UPDATE_URL`             |
| 本地开发版         | 不检查更新                                                   | `app.isPackaged === false` 时直接放行             |

- 正式版**不需要**任何 GitHub Token：`publish.private: false`，客户端匿名访问 `github.com` 网页端点（`/releases/latest`、`/releases.atom`）与资产下载，不调用 `api.github.com`，不受匿名 API 配额限制。
- `POLARNIGHT_UPDATE_URL` 只用于**本地测试**，且只能填 Generic 假服务器根地址（例如 `http://127.0.0.1:3999/polarnight`）。填 GitHub 页面地址会被直接拒绝并给出提示，避免把正式更新源误当成 Generic 源。
- 正式版 API 地址：`http://149.248.17.85:3000`（写在 `.env.production`，仅生产构建生效）。

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
3. 启动本地假更新服务器 `scripts/fake-update-server.mjs`（默认 `http://127.0.0.1:3999/polarnight`，返回同版本 `latest.yml`）；
4. 用独立 `--user-data-dir=dist/.update-test-profile` 启动 exe，并注入 `POLARNIGHT_UPDATE_URL`；
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
$env:POLARNIGHT_UPDATE_URL="http://127.0.0.1:3999/polarnight"
.\dist\win-unpacked\polarnight.exe --user-data-dir=dist\.update-test-profile
```

`POLARNIGHT_UPDATE_URL` 只在本次启动生效，不要写入系统环境变量或注册表。

### 2.4 假更新服务器的行为

`scripts/fake-update-server.mjs`：

- **只按 URL 的 pathname 匹配 `latest.yml`**，忽略 `?noCache=...` 查询参数（这是之前 404 的根因）。
- 默认返回 `package.json` 的版本号，应用应显示「已是最新版本」并进入登录页。
- 环境变量：
  - `FAKE_UPDATE_PORT`：端口，默认 `3999`；
  - `FAKE_UPDATE_VERSION`：返回的版本号，默认当前版本；
  - `FAKE_UPDATE_PATH`：feed 路径前缀，默认 `/polarnight`；
  - `FAKE_UPDATE_DIR`：可选静态目录。目录下有 `latest.yml` 时原样返回，并同时提供其中列出的安装包/blockmap 下载（用于本地完整更新流程）。
- 支持 `GET`/`HEAD`，其他方法返回 405；未匹配路径返回 404，并在日志中打印请求行。

### 2.5 期望结果

| 场景                             | 期望界面                                           |
| -------------------------------- | -------------------------------------------------- |
| 假服务器返回同版本               | 短暂显示「正在检查更新…」→「已是最新版本」→ 登录页 |
| 假服务器返回更高版本且提供安装包 | 自动下载 → 自动安装并重启 → 重启后再检查 → 登录页  |
| 假服务器未启动 / 地址错误        | 更新门禁停留，显示错误与「重试」，**不出现登录框** |

---

## 3. 正式安装测试模式（GitHub Releases）

正式安装测试验证的是「真实分发链路」，不能用假服务器替代。正式版更新源是 GitHub Releases 公开仓库，客户端不内置 Token。

### 3.0 一次性迁移说明（v1.0.0 → v1.0.1）

已安装的 v1.0.0 客户端内嵌的更新源是 `http://127.0.0.1:13001`（早前的本地联调地址），**无法远程修改**，因此 v1.0.0 不能自动升级。v1.0.1 必须由用户**手动下载安装**（覆盖安装，`appId` 与 `userData` 不变，自动登录与本地聊天记录保留）。从 v1.0.1 起，后续版本走 GitHub Releases 全自动更新。

### 3.1 前置条件

1. `electron-builder.yml` 的 `publish` 为 `provider: github` / `owner: Dandelion-Z` / `repo: Polar-Night` / `private: false` / `vPrefixedTagName: true`。
2. 构建时使用正式 API 地址 `VITE_API_BASE_URL=http://149.248.17.85:3000`（已写入 `.env.production`，也可用命令行环境变量覆盖）。
3. 新版本安装包的 `version` 必须**高于**当前最新 Release（`package.json`）。
4. 构建产物包含 `latest.yml`、`polarnight-<版本>-setup.exe`、`polarnight-<版本>-setup.exe.blockmap`。
5. 构建后先自查 `dist/win-unpacked/resources/app-update.yml`，应为：

   ```yaml
   provider: github
   owner: Dandelion-Z
   repo: Polar-Night
   private: false
   updaterCacheDirName: polarnight-updater
   ```

6. 三个文件上传到同一个 GitHub Release：
   - tag 带 `v` 前缀（如 `v1.0.1`）；
   - 必须是**正式 release**，不能是 draft 或 prerelease（`allowPrerelease=false`）；
   - 勾选 **Set as the latest release**；
   - 资产名不得改动（electron-updater 按 `latest.yml` 里的 `path` 拼下载地址）。

### 3.2 步骤

1. 安装**旧版本**安装包（`dist/polarnight-<旧版本>-setup.exe`），先不要启动。
2. 在 GitHub 创建新版本 Release 并上传 `latest.yml`、`*.exe`、`*.blockmap`。
3. 启动旧版本：
   - 期望：更新门禁 → 「发现新版本」→ 自动下载（显示进度）→ 下载完成后自动静默安装并重启；
   - 重启后再次检查更新 → 确认已是最新 → 进入登录页。
4. 登录并做一次收发消息，确认升级没有破坏 `userData`（自动登录凭证、本地 `messages.db` 仍可用）。
5. 若安装包已签名，验证安装/升级过程没有 SmartScreen 或签名错误。

### 3.3 发布前验证（不发 Release 也能做）

直接运行 `dist/win-unpacked/polarnight.exe`，**不要**设置 `POLARNIGHT_UPDATE_URL`：

- 若 GitHub 上最新正式版版本号低于本地版本，期望「已是最新版本」→ 登录页；
- 这一步同时验证 `releases.atom` / `releases/latest` / `latest.yml` 抓取与 semver 比较四条链路；
- 失败时主进程日志会打印 `[updater] 更新源 github：Dandelion-Z/Polar-Night`，可据此定位是仓库配置还是网络问题。

### 3.4 检查清单

- [ ] 启动旧版本后没有直接进入登录页（先检查更新）
- [ ] 自动下载有进度，且没有弹窗要求确认
- [ ] 下载完成后自动退出并静默安装，随后自动启动新版本
- [ ] 新版本启动后再次检查，确认无更新后才出现登录页
- [ ] 升级后 `userData` 未被清空：自动登录仍可用、本地聊天记录仍在
- [ ] 更新源不可达（如断网、GitHub 被拦截）时停留在门禁并显示可读中文错误与「重试」
- [ ] 差分更新生效：下载量远小于完整安装包（依赖 `*.blockmap` 与 `nsis.differentialPackage: store-asar`）

---

## 4. 常见问题

| 现象                                                    | 原因                                                                                     | 处理                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 门禁显示「未找到更新配置（app-update.yml）…」           | 运行目录不是完整安装目录（例如手工拷走了 exe，或绿色版解压不全）                          | 使用完整安装包安装；`electron-builder --dir` 产物也会生成该文件       |
| 门禁显示「未配置更新服务器地址（占位地址 …）」          | 打包时 `publish` 仍是 generic + `.invalid` 占位地址                                       | 确认 `electron-builder.yml` 的 `publish` 为 github 配置后重新打包     |
| 门禁显示「无法读取 GitHub 发布信息…」                   | 仓库地址错误，或该仓库还没有正式 Release（draft/prerelease 不算）                         | 核对 `owner`/`repo`，确认已发布正式 Release                          |
| 门禁显示「该版本发布缺少更新描述文件 latest.yml…」      | Release 里没上传 `latest.yml`，或资产名被改过                                             | 补齐 `latest.yml` + `*-setup.exe` + `*.blockmap`，名字不要改          |
| 门禁显示「GitHub 请求过于频繁或暂时拒绝访问」            | 出口 IP 被 GitHub 限流，或网络中间设备返回 403                                            | 稍后重试；必要时更换网络                                             |
| 设置 `POLARNIGHT_UPDATE_URL` 后提示「不能填 GitHub 地址」 | 该变量只用于 Generic 本地测试，正式更新源由 `app-update.yml` 提供                         | 正式测试时不要设置该变量；本地测试填 `http://127.0.0.1:3999/polarnight` |
| 假服务器返回 404                                        | 旧脚本按 `endsWith('latest.yml')` 匹配，被 `?noCache=` 破坏                               | 使用 `scripts/fake-update-server.mjs`（按 pathname 匹配）            |
| 能进登录页但登录提示「无法连接服务器」                  | 构建时未设置 `VITE_API_BASE_URL`，生产 CSP 只允许 `'self'`                                | 确认 `.env.production` 或命令行提供正式 API 地址后重新构建            |
| 开发模式 Electron 直接崩溃                              | 本机 Electron 环境问题（最小示例同样崩溃）                                                | 与更新无关；改用打包测试模式                                          |

---

## 5. 与旧产物的区别

- `dist/win-unpacked` 是**测试构建**：CSP 指向测试用的 API 地址（默认 `http://localhost:3000`），且 `electron-builder --dir` 会写入 github 版 `resources/app-update.yml`；直接双击会去访问真实 GitHub，用 `npm run test:packaged` 启动（脚本会注入 `POLARNIGHT_UPDATE_URL` 指向假服务器）。
- 已发布的 `dist/mychatapp-1.0.0-setup.exe` 内嵌更新源是 `http://127.0.0.1:13001`，**无法自动升级**，只能人工覆盖安装 v1.0.1 及以后版本。
- v1.0.1 起，正式安装包内嵌 GitHub Releases 更新源，可全自动升级。
