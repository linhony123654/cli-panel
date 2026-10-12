<!-- generated-by: init-project-docs · verified: 2026-10-12 · commit: 84118ac · dir-fp: 500d077f6df1 -->
# 架构总览

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 22，CommonJS | 无构建步骤，无框架 |
| HTTP | 原生 `http` + 手写路由表 | `server.js` 里的 `route(method, pattern, handler)`，`:param` 语法 |
| 前端 | Vue 3 全局构建（`vue.global.prod.js`，从 `node_modules` 以 `/vue.js` 提供） | 运行时编译模板 → CSP 必须放行 `unsafe-eval` |
| 依赖 | `smol-toml`（Codex `config.toml` 解析）、`vue` | 仅此两项运行时依赖 |
| 进程 | pm2（`cli-panel`） | 监听 `9099`；`CLI_PANEL_DATA` 可重定位全部运行时状态 |

## 顶层目录与分层

```
cli-panel/
├── server.js      # 唯一 HTTP 入口：路由表、鉴权、CSRF、静态资源、状态聚合
├── lib/           # 服务端逻辑，每模块一个关注点，全部同步 require 进 server.js
├── public/        # 前端（无构建）：index.html + app.js + style.css + favicon.svg
├── data/          # 运行时状态（gitignored）：store.json / auth.json / sessions.json / backups/
└── node_modules/  # 依赖，其中 vue 被当静态资源直接对外提供
```

### `lib/` 模块边界

| 模块 | 职责 | 依赖方向 |
|---|---|---|
| `util.js` | 路径常量、原子写、备份、路径白名单、通用校验 | **最底层**：任何模块可依赖它，它不依赖任何业务模块 |
| `store.js` | 供应商库与 API Key 的持久化（`data/store.json` + 独立 Key 文件） | 依赖 `claude`/`codex`（首启时从现有配置反向导入） |
| `auth.js` | 口令哈希、会话令牌、登录限速 | 依赖 `util` |
| `claude.js` | 启动器解析/渲染/归一化、别名 | 依赖 `util` |
| `codex.js` | `~/.codex/config.toml` 与 `.config.toml` profiles（读同步，写异步） | 依赖 `util` |
| `skills.js` / `memory.js` / `mcp.js` | 三客户端（Claude/Codex/Qoder）的 Skill、规则文件、MCP 服务 | 依赖 `util` |
| `sessions.js` | tmux 会话/窗口的列举与操作 | 依赖 `util` |
| `usage.js` | 解析 `.jsonl` 会话历史，统计 token 与缓存 | 依赖 `util` |
| `git.js` / `system.js` / `logs.js` / `cleaner.js` / `doctor.js` | 仓库巡检、资源 HUD、日志、磁盘清理、环境自检 | 依赖 `util` |
| `ping.js` | 供应商端点测活 | 依赖 `util` |
| `backup_bundle.js` | 全量配置导出/导入（聚合上面多个模块） | **最上层**：依赖 `store`/`claude`/`codex`/`skills`/`memory` |

### 禁止依赖（边界契约）

- `util.js` **禁止** require 任何其他 `lib/` 模块——它是被所有人依赖的底座，反向依赖会造成循环。
- `public/app.js` **禁止**直接 `fetch()`：必须走 `api()` 助手（统一注入 CSRF 头与 401 处理）。
- `lib/*` **禁止**直接写 `data/` 之外的任意路径：写入必须经 `util.isWritable()` 白名单。
- 前端**禁止**引入构建产物或外部 CDN：CSP 为 `default-src 'self'`，唯一放行的是同源静态资源。

## 请求生命周期

```
浏览器 → server.js:http.createServer
  1. 注入 SECURITY_HEADERS（CSP / nosniff / frame-deny）
  2. 命中 STATIC 表 → 直接吐 public/ 文件
  3. 非 /api/ → 404
  4. 路由匹配；写操作先查 X-Requested-With: cli-panel（否则 403）
  5. 非 open 路由查会话 Cookie（否则 401）
  6. 解析 body（≤1MB）→ handler → JSON 响应
```

## 安全模型

- **认证**：单口令 + HttpOnly/SameSite=Strict Cookie；口令仅存哈希于 `data/auth.json`；登录有按 IP 限速。
- **CSRF**：所有写操作要求自定义请求头，跨站表单/图片无法伪造。
- **路径白名单**：`WRITABLE_ROOTS` 限定可写前缀，`isWritable()` 在写入前校验。
- **代理信任**：仅当直连来自 `127.0.0.1` 时才采信 `X-Forwarded-For`（见 `clientIp()`），供反代部署使用。
