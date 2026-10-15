# 进程查找关闭工具 (process-manager)

Apple 以外平台的本机进程 / 端口查找与关闭工具：**Windows + Linux GUI（Tauri）**，以及 **Linux CLI（`procman`）**。共享 Rust 核心库 `procman-core`。

## 目录

- `crates/procman-core` — 进程列表、端口占用、项目目录推断、关闭与重启检测
- `crates/procman-cli` — Linux 命令行 `procman`
- `app` — Tauri 2 桌面 GUI（界面按 `design/v2_*` + `SPEC.md`）
- `docs/` — PRD、设计稿、测试用例（同步自仓库根目录资料）

## Linux CLI

```bash
cd /path/to/process-manager
cargo build -p procman-cli --release
./target/release/procman find --name node
./target/release/procman find --port 5173
./target/release/procman list
./target/release/procman related <pid>
./target/release/procman kill <pid> --yes
./target/release/procman kill --name node --yes
```

退出码：0 成功；1 一般错误；2 无匹配；3 权限不足；4 部分失败。

## GUI（Tauri）

依赖：Rust、Node、Linux 需 webkit2gtk 等（见 Tauri 官方 prerequisites）。

```bash
cd app
npm install
npm run tauri dev          # 开发（会起 Vite :1420）
npm run tauri build        # 发布：必须用这条，会内嵌前端
# 可双击/直接跑：
../target/release/process-manager
# 或 ../dist/process-manager-linux-amd64
```

不要用裸 `cargo build --release` 当 GUI 发布包：那不会按 Tauri 方式打包前端，容易出现连 `localhost:1420` 白屏。

## 说明

- 数据只在本机，不上传
- `.onnx` 等无关；本项目无模型文件
