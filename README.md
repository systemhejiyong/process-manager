# 进程查找关闭工具 (process-manager)

Apple 以外平台的本机进程 / 端口查找与关闭工具：**Windows + Linux GUI（Tauri）**，以及 **Linux CLI（`procman`）**。共享 Rust 核心库 `procman-core`。

数据只在本机，不上传。

## 下载（Release）

源码双仓对齐（`main`）：

- **GitHub**：https://github.com/systemhejiyong/process-manager  
- **Gitee**：https://gitee.com/hogan_dev/process-manager  

**安装包 / 二进制**目前挂在 **Gitee Release `v0.1.0`**（GitHub 侧 Release 资产后补；源码与 tag 已在 GitHub）。

### 怎么下安装包

1. 打开 [Gitee v0.1.0 Release](https://gitee.com/hogan_dev/process-manager/releases/tag/v0.1.0)  
2. 在 **资产（Assets）** 里按平台下载  
3. 若打不开：先登录 Gitee；私有仓需有仓库权限  

直达：

- **[v0.1.0 安装包（Gitee）](https://gitee.com/hogan_dev/process-manager/releases/tag/v0.1.0)**（当前有资产）  
- Gitee 全部发行版：https://gitee.com/hogan_dev/process-manager/releases  
- GitHub 仓库 / tag：https://github.com/systemhejiyong/process-manager/releases （资产待补）  

| 平台 | 建议下载资产 |
| --- | --- |
| Windows | `ProcessManager_0.1.0_x64_en-US.msi`（安装）或 `process-manager.exe`（便携）；CLI 用 `procman.exe` |
| Linux | `ProcessManager_0.1.0_amd64.deb`，或 GUI 二进制 `process-manager-linux-amd64`；CLI 用 `procman` |

克隆示例：

```bash
git clone https://github.com/systemhejiyong/process-manager.git
# 或
git clone https://gitee.com/hogan_dev/process-manager.git
```

本机构建产物也可在仓库 `dist/`（一般不入仓，仅构建机本地）。

## 为什么用它

| 优势 | 说明 |
| --- | --- |
| **按需查找，启动不卡** | 打开不拉全量进程；按进程名或端口再搜，有明确 loading |
| **支持端口查询** | 👍限制Agent各种暂用端口，特别是node，通过这个可以快速查询哪些端口被哪些项目暂用了 |
| **项目目录可见** | 👍结果里直接看占用是否落在某个项目路径 |
| **相关进程一键清** | 点选一行展开父/子/同路径相关进程，可勾选连带关闭 |
| **右键快捷操作** | 关单个 / 关相关 / 复制 PID·路径·端口·命令行 |
| **一屏三区** | 匹配结果、相关进程、操作日志同屏，各区内滚，不整页乱滚 |
| **Win + Linux** | GUI 双端；Linux 另有 `procman` CLI |

## 界面预览

**启动不拉全量 — 先搜再看**

![按需搜索空态](docs/readme/01-on-demand-search.png)

**按进程名 / 端口查找，带项目目录**

![按名查找结果](docs/readme/02-search-by-name.png)

**相关进程展开，可勾选连带关闭**

![相关进程](docs/readme/03-related-processes.png)

**行内右键：关闭 / 关相关 / 复制字段**

![右键菜单](docs/readme/04-context-menu.png)

**一屏布局：结果 + 相关 + 操作日志**

![一屏与日志](docs/readme/05-onescreen-log.png)

**桌面主界面（Win/Linux GUI 同源；示意含 Windows 路径）**

![桌面主界面](docs/readme/06-windows.png)

## 目录

- `crates/procman-core` — 进程列表、端口占用、项目目录推断、关闭与重启检测
- `crates/procman-cli` — Linux 命令行 `procman`
- `app` — Tauri 2 桌面 GUI（界面按 `docs/design/v2_*` + `SPEC.md`）
- `docs/` — PRD、设计稿、测试用例、README 截图
- `dist/` — 本机构建产物（一般不入仓）

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

Windows 包路径示例（本机构建后）：`D:\work\process-manager\dist\windows\`。

## 远程仓库

双远程，内容对齐（以 `main` 为准）：

- GitHub：https://github.com/systemhejiyong/process-manager  
- Gitee：https://gitee.com/hogan_dev/process-manager （当前 Release 安装包所在）  

```bash
git remote add origin https://github.com/systemhejiyong/process-manager.git   # 或 Gitee URL
git remote add gitee https://gitee.com/hogan_dev/process-manager.git
git push origin main
git push gitee main
```

## 说明

- 数据只在本机，不上传
- 无模型文件；`.onnx` 等无关
