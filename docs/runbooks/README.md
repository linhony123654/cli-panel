<!-- generated-by: init-project-docs · verified: 2026-10-12 · commit: 84118ac -->
# 操作手册

## 已有手册

- [配置包导出/导入回归验证](#配置包导出导入回归验证)

## 配置包导出/导入回归验证

改动 `lib/backup_bundle.js`、`lib/claude.js` 的渲染逻辑，或新增启动器类型后跑一遍。

1. 在**沙箱数据目录**里做，不碰真实 `data/`：
   ```bash
   cd /home/ubuntu/cli-panel
   tmp=$(mktemp -d)
   CLI_PANEL_DATA=$tmp/data node -e '
   const fs=require("fs"),path=require("path"),os=require("os");
   const bin=path.join(os.homedir(),".local","bin");
   const b=require("./lib/backup_bundle");
   (async()=>{
     const before={};
     for(const f of fs.readdirSync(bin)) if(/^claude-/.test(f)) before[f]=fs.readFileSync(path.join(bin,f),"utf8");
     const bundle=b.exportBundle();
     console.log("exported launchers:",bundle.launchers.length,"with text:",bundle.launchers.filter(l=>l.text).length);
     for(const f of Object.keys(before)) fs.writeFileSync(path.join(bin,f),"#!/usr/bin/env bash\n# TAMPERED\n");
     const r=await b.importBundle(bundle);
     console.log("counts:",JSON.stringify(r.counts),"skipped:",JSON.stringify(r.skipped.launchers));
     let same=0,diff=[];
     for(const [f,t] of Object.entries(before)) (fs.readFileSync(path.join(bin,f),"utf8")===t?same++:diff.push(f));
     console.log("restored identical:",same+"/"+Object.keys(before).length,diff);
   })();'
   rm -rf "$tmp"
   ```

2. 期望结果：
   - `with text` == `exported launchers`（每个启动器都带原文）
   - `skipped.launchers` 为空（若本地缺对应供应商，属预期跳过，需人工确认）
   - `restored identical` 为 `N/N`——**任何 diff 都是回归**

3. 顺带确认 `~/.codex/config.toml` 仍可解析（导入会重写 profiles）：
   ```bash
   node -e 'require("smol-toml").parse(require("fs").readFileSync(process.env.HOME+"/.codex/config.toml","utf8"));console.log("ok")'
   ```

### 必须走真实 HTTP（不可只测函数）

函数级往返测试**证明不了功能可用**——曾出现「`exportBundle`/`importBundle` 直调全部通过，但接口实际不可用」的情况（请求体超限，见 `docs/incidents/`）。每次改接口后跑：

```bash
cd /home/ubuntu/cli-panel
node -e "const b=require('./lib/backup_bundle');require('fs').writeFileSync('/tmp/snap.json',JSON.stringify(b.exportBundle()))"
PW=$(cat data/INITIAL_PASSWORD.txt | tr -d '\n\r ')
curl -s -o /dev/null -X POST -H 'X-Requested-With: cli-panel' -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PW\"}" -c /tmp/ck.txt http://127.0.0.1:9099/api/login
curl -s -w '\nHTTP %{http_code}\n' -X POST -H 'X-Requested-With: cli-panel' -H 'Content-Type: application/json' \
  -b /tmp/ck.txt --data-binary @/tmp/snap.json http://127.0.0.1:9099/api/system/import
rm -f /tmp/ck.txt /tmp/snap.json
```

期望：`HTTP 200` 且 `skipped_total: 0`。**任何非 200 或空响应都是回归。**

### 覆盖范围回归清单

快照应当同时含以下各项（缺一即为回归）：

| 类别 | 本机基准 | 说明 |
|---|---|---|
| `launchers` | 13 | 7 个 claude 启动器 + 6 个 codex 启动器；别名脚本存在时也计入 |
| `providers` | 3 | 含 API Key |
| `codex_config` | 1 | `~/.codex/config.toml` 原文 |
| `codex_catalogs` | 7 | profile 引用的 catalog JSON |
| `codex_profiles` | 8 | |
| `claude_settings` | 1 | `~/.claude/settings.json` 原文 |
| `statusline` | 1 | `~/.claude/statusline.py` |
| `skills` | 21 | 仅 `SKILL.md`；附属文件另见 `export_warnings` |
| `rules` | 10 | |

`export_warnings` 会列出**未纳入快照**的内容（如多文件 skill 的 `references/`、`assets/`、脚本目录）。它是「包不完整」的唯一信号，不要忽略。

数量会随本机配置变动，关键是 **`skipped_total == 0` 且还原后逐文件哈希一致**。

### 安全回归（必测）

导入接口接受用户 JSON，`provider.id` / catalog `file` / skill `targets` 都会拼进路径。用恶意 id 复测：

```bash
CLI_PANEL_DATA=$(mktemp -d)/data node -e '
const b=require("./lib/backup_bundle");
(async()=>{
  const r=await b.importBundle({providers:[{id:"../../../../../tmp/PWN",name:"x",key:"S"}]});
  console.log(r.counts.providers, JSON.stringify(r.skipped.providers));
})();'
```

期望：`counts.providers` 为 `0`，`skipped.providers` 给出「id 不合法」，且 `/tmp/PWN.key` **未被创建**。

### 异常分支

- `restored identical` 有 diff → 检查 `importBundle` 是否走到了 `form` 回退分支（原文丢失），见 `docs/incidents/README.md`。
- `skipped.launchers` 非空且原因是"本地无供应商" → 快照来自另一台机器，需先导入供应商再导入启动器。

### 回滚

导入前每个被覆盖的文件都会自动备份到 `data/backups/<stamp>__<编码路径>`；
在面板「备份」页按路径筛选即可还原，或直接 `cp` 回原位置。

## 手册标准格式

1. 正常流程（编号步骤）
2. 异常分支（"如果 X，见 incidents/xxx.md"）
3. 回滚命令（如有）
