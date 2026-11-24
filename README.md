# mychatapp

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### 打包测试 / 自动更新测试

日常开发用 `npm run dev`，开发环境不检查自动更新。需要验证自动更新相关行为时：

```bash
# 重新构建 win-unpacked，启动本地假更新服务器，并用独立 userData 启动应用
$ npm run test:packaged

# 复用已有构建做冒烟
$ npm run test:packaged -- --skip-build --smoke
```

三种测试模式（开发 / 打包测试 / 正式安装测试）的完整流程、假更新服务器参数和常见问题见
[docs/AUTO_UPDATE_TESTING.md](docs/AUTO_UPDATE_TESTING.md)。

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
