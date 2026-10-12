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
