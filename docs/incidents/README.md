<!-- generated-by: init-project-docs · verified: 2026-10-12 · commit: 84118ac -->
# 重复故障模式

| 模式 | 出现次数 | 根因类别 | 预防措施 |
|------|---------|---------|---------|
| 导入/恢复静默跳过全部条目 | 1 | 空 `catch {}` 吞掉参数/类型错误 | 导入结果必须返回 `counts` + `skipped`（已落地）；新增导入分支不得用空 catch |
| 用户输入直接拼路径导致目录逃逸 | 1 | 未校验的 id/filename 进入 `path.join` | 任何来自 JSON 的 id/文件名在拼路径前必须过 `RE.id`/`RE.cmd` 或严格文件名正则；见 `docs/runbooks/` 安全回归 |
| 只测函数、漏测 HTTP 层 → 功能整体不可用 | 1 | 验证方式绕过了真实的请求路径 | 改接口后必须用 `curl` 走一遍真实 HTTP（含登录），见 `docs/runbooks/`；函数级往返测试通过 ≠ 功能可用 |
| 超限请求被 `req.destroy()` 掐断，客户端收不到 413 | 1 | 在 `data` 事件里销毁 socket | 超限时只 `reject` + `req.resume()` 排空，让响应正常返回；见 `server.js:readBody` |
| pm2 反复重启（错误日志堆积 SyntaxError） | 1 | 保存了半截文件后 pm2 自动重启 | 改完 `server.js` 先 `node --check` 再让 pm2 拉起 |

## 单篇格式

见 `YYYY-MM-DD-简短描述.md`，需写明：现象 → 根因 → 证据 → 修复 → 防复发。
