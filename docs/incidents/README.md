<!-- generated-by: init-project-docs · verified: 2026-10-12 · commit: 84118ac -->
# 重复故障模式

| 模式 | 出现次数 | 根因类别 | 预防措施 |
|------|---------|---------|---------|
| 导入/恢复静默跳过全部条目 | 1 | 空 `catch {}` 吞掉参数/类型错误 | 导入结果必须返回 `counts` + `skipped`（已落地）；新增导入分支不得用空 catch |
| pm2 反复重启（错误日志堆积 SyntaxError） | 1 | 保存了半截文件后 pm2 自动重启 | 改完 `server.js` 先 `node --check` 再让 pm2 拉起 |

## 单篇格式

见 `YYYY-MM-DD-简短描述.md`，需写明：现象 → 根因 → 证据 → 修复 → 防复发。
