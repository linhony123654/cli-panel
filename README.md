# CLI Panel

> 一站式 Linux VPS 上的 AI 编程命令行（Claude Code & Codex CLI）可视化管理面板与运维中枢。

---

## 🌟 核心功能

- **🚀 启动器与参数配置 (Launchers & Profiles)**
  - Claude Code 专属启动脚本一键生成与参数托管（主模型指定、上下文窗口 256k/500k/1M 下拉切换、思考强度调节、429 自动重试降级）。
  - Codex CLI `config.toml` 与 Profiles 参数管理（`model_providers`、`wire_api`、推理参数、额外环境变量动态配置）。
  - 全局默认别名（如 `cl`）一键切换与软链接维护。
- **🌐 供应商与多模型路由 (Providers & Models)**
  - 统一配置 Anthropic 协议与 OpenAI Responses 协议代理中转站或官方入口。
  - API 密钥加密保存在本地受控目录，前台敏感信息全量脱敏展示。
  - 支持模型单键测活与延时健康巡检。
- **📦 扩展技能与 MCP 服务 (Skills & MCP)**
  - 跨客户端技能（Claude Code / Codex / Qoder Skills）统一扫描、状态感知与管理。
  - MCP (Model Context Protocol) 服务的添加、环境变量配置与一键启停。
- **🔍 Git 仓库巡检与可视化 Diff (Git Inspector)**
  - 自动探测工作区各代码仓库分支状态、未提交变动与未推送提交。
  - 内置高性能代码差异查看器，支持就地查看 Diff 与快捷代码动作。
- **🧹 手机管家式磁盘垃圾智能清理 (Disk Cleaner)**
  - 根分区容量与占用实时 HUD 刻度盘、清理降幅预测。
  - 智能分类扫描：包管理器依赖缓存（npm cacache、uv/pip）、CLI 运行时临时文件、/tmp 废弃物、Systemd 日志轮转清理、开发框架构建缓存。
  - >30MB 大文件分析排查与吃磁盘目录排行。
  - 严格安全目录白名单与禁删保护栅栏，确保系统代码零风险。
- **📊 会话历史与 Token 消耗审计 (Session Analytics)**
  - 扫描解析 Claude Code 与 Codex CLI 会话历史 `.jsonl` 日志。
  - 统计输入 Prompt、输出 Completion 与 Prompt Caching 命中节省。
  - 支持单个会话删除、多选批量删除、按保留天数清理早期旧会话，及一键安全清理 0 Token 空白会话。
- **📋 实时日志与终端诊断 (Daemon Logs & Diagnostics)**
  - 历史 Prompt 指令流检索与快速复用。
  - 429 限流告警、工具执行报错与服务异常诊断。
  - Tmux 活跃终端与后台守护进程实时输出流无缝捕获。
- **🧠 记忆库与项目准则沉淀 (Memory & Rules)**
  - 统一查看与编辑持久化长期记忆（Memory）及自动维护的 `MEMORY.md` 索引。
  - 各项目 `CLAUDE.md` / `AGENTS.md` 工程规范在线对账。
- **💾 全量配置包导出与迁移 (Config Bundle Export / Import)**
  - 一键打包供应商与密钥、Claude 启动器（含手写脚本原文）、Codex Profiles、Skills 与项目规则为单个 JSON。
  - 导入时逐类回报成功数与**跳过明细**（缺供应商、规则文件不存在等），不再静默失败。
- **🩺 系统环境自检与修复 (Doctor)**
  - 自动化检查 Node.js、Go 编译器、Python 环境、Tmux 终端、网络代理连通性并提供一键修复指令。

---

## 📱 移动端深度适配

全站经过响应式断点与移动端交互优化：
- 顶部 HUD 指示器与快捷抽屉自适应。
- 触控横向平滑分段导航，告别按钮文字溢出或挤压截断。
- 手机竖屏下操作按钮对称铺满与弹性伸缩。

---

## 🚀 快速上手

### 1. 克隆与安装依赖

```bash
git clone https://github.com/linhony123654/cli-panel.git
cd cli-panel
npm install
```

### 2. 启动服务

```bash
node server.js
```

默认监听端口为 `9099`（可通过环境变量 `PORT=9099 HOST=0.0.0.0` 调整，`CLI_PANEL_DATA=<dir>` 可重定位运行时数据目录）。
初次启动将自动在本地创建 `data/` 目录，并在终端与 `data/INITIAL_PASSWORD.txt` 输出一次性安全随机密码。

### 3. 使用 PM2 保持常驻（推荐）

```bash
pm2 start server.js --name cli-panel
pm2 save
```

---

## 🔒 安全说明

- 配置文件与认证凭据默认存放于本地 `data/` 目录（已内置 `.gitignore` 排除，切勿上传至代码仓库）。
- 写入与恢复操作受严格的路径白名单限制，禁止越权操作系统关键路径。
- 所有非 GET 请求均受 CSRF 请求头保护。

---

## 📄 License

ISC License
