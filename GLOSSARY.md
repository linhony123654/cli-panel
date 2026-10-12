<!-- generated-by: init-project-docs · verified: 2026-10-12 · commit: 84118ac -->
# 术语表

| 术语 | English | 项目内定义 | 常见误用 |
|------|---------|-----------|---------|
| 启动器 | Launcher | `~/.local/bin` 下由面板生成或纳管的 bash 脚本，导出 `ANTHROPIC_BASE_URL` 等环境变量后 `exec claude` | 不要与"别名"混用：别名（alias）只是指向某个启动器的软链包装 |
| 托管 / 手写 | Managed / Hand-written | 脚本含 `MARKER` 注释与 `# provider:` 行为**托管**，可被面板重新渲染；无标记的为**手写**，面板只读不改 | 手写脚本没有 provider 归属，`normalize()` 会拒绝，不能用 form 重建 |
| 供应商 | Provider | 一个上游入口（Anthropic 协议或 OpenAI Responses 协议），含 base_url 与 API Key；Key 单独存放在 `~/.config/cli-panel/keys/<id>.key` | 供应商 ≠ 模型；模型挂在供应商的 `models` 列表里 |
| 配置包 / 快照 | Bundle / Snapshot | `/api/system/export` 产出的完整 JSON（供应商+Key、启动器原文、别名、`~/.codex/config.toml` 与 catalog、Codex profiles、Skills、Rules）——目标是**整机迁移级**重建 | 不要与 `data/backups/` 里的单文件备份混淆：后者是每次写入前的自动副本。快照含明文密钥，视同机密文件 |
| 跳过项 | Skipped | 导入时无法还原的条目及其原因（缺供应商、规则文件不存在、TOML 解析失败等），随 `counts` 一起返回并展示在弹窗里 | 不要只看 `ok` 字段：`ok=false` 表示有跳过项，不等于整体失败 |
| 可写根 | Writable Root | `lib/util.js` 中 `WRITABLE_ROOTS` 列出的允许面板写入的路径前缀 | 新增写入目标必须先进白名单，不能绕过 `isWritable()` |
| 会话 | Session | 两种含义，看上下文：`lib/usage.js` 指 Claude/Codex 的 `.jsonl` 历史记录；`lib/sessions.js` 指 tmux 会话/窗口 | 面板导航里的"会话"指前者，Tmux 面板里指后者 |
| 面板数据 | Panel Data | `data/` 目录（`store.json`、`auth.json`、`sessions.json`、`backups/`），运行时状态，不入库 | 不要写进代码目录或提交到 git |
