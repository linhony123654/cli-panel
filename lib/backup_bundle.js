'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');
const claude = require('./claude');
const codex = require('./codex');
const skills = require('./skills');
const memory = require('./memory');
const { PATHS, RE, atomicWrite, backup } = require('./util');

function exportBundle() {
  const s = store.get() || store.load();
  const providersWithKeys = (s.providers || []).map(p => ({
    ...p,
    key: store.readKey(p.id)
  }));
  // 同时带上原始脚本文本：手写启动器（无 # provider: 标记）无法用 form 重建，只能按原文还原
  const launchers = claude.scan().map(l => ({
    cmd: l.cmd,
    text: l.text,
    form: { ...l.parsed, cmd: l.cmd, key_file: undefined }
  }));
  const profiles = codex.listProfiles();
  const skList = skills.listSkills().map(sk => ({
    id: sk.id,
    name: sk.name,
    description: sk.description,
    fullContent: sk.fullContent,
    targets: sk.targets
  }));
  const ruleList = memory.listRules().map(r => {
    try {
      return { id: r.id, name: r.name, path: r.path, content: memory.getRule(r.id).content };
    } catch { return null; }
  }).filter(Boolean);

  return {
    version: '1.1.0',
    exported_at: new Date().toISOString(),
    alias: s.alias || { name: 'cl', target: '' },
    providers: providersWithKeys,
    launchers,
    codex_profiles: profiles,
    skills: skList,
    rules: ruleList
  };
}

async function importBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('无效的导入数据格式 (需要 JSON 对象)');
  }

  const counts = {
    providers: 0,
    launchers: 0,
    profiles: 0,
    skills: 0,
    rules: 0
  };

  // 1. Providers（面板进程外调用时 store 尚未加载，兜底 load）
  if (Array.isArray(bundle.providers)) {
    const s = store.get() || store.load();
    for (const p of bundle.providers) {
      if (!p.id || !p.name) continue;
      const idx = s.providers.findIndex(x => x.id === p.id);
      const provData = {
        id: p.id,
        name: p.name,
        anthropic_url: p.anthropic_url || '',
        openai_url: p.openai_url || '',
        note: p.note || '导入自配置包',
        models: Array.isArray(p.models) ? p.models : []
      };
      if (idx >= 0) {
        s.providers[idx] = provData;
      } else {
        s.providers.push(provData);
      }
      if (p.key) {
        store.writeKey(p.id, p.key);
      }
      counts.providers++;
    }
    if (bundle.alias) {
      s.alias = bundle.alias;
    }
    store.save();
  }

  // 2. Launchers
  // 优先按导出时的原始脚本还原（手写脚本无 # provider: 标记，只能靠原文）；
  // 旧版快照没有 text，退回用 form 重新渲染（需要本地已有对应供应商）。
  const skippedLaunchers = [];
  if (Array.isArray(bundle.launchers)) {
    const providers = (store.get() || store.load()).providers || [];
    for (const l of bundle.launchers) {
      if (!l.cmd || !RE.cmd.test(l.cmd)) { skippedLaunchers.push({ cmd: l && l.cmd, reason: '命令名缺失或不合法' }); continue; }
      try {
        let script;
        if (typeof l.text === 'string' && l.text.startsWith('#!')) {
          script = l.text;
        } else if (l.form) {
          const prov = providers.find(x => x.id === l.form.provider);
          if (!prov) { skippedLaunchers.push({ cmd: l.cmd, reason: `快照无原文，且本地无供应商 ${l.form.provider || '(空)'}` }); continue; }
          script = claude.render(claude.normalize({ ...l.form, cmd: l.cmd }, providers), prov);
        } else {
          skippedLaunchers.push({ cmd: l.cmd, reason: '缺少原文与 form' });
          continue;
        }
        const scriptPath = path.join(PATHS.bin, l.cmd);
        fs.mkdirSync(PATHS.bin, { recursive: true });
        if (fs.existsSync(scriptPath)) backup(scriptPath);
        atomicWrite(scriptPath, script);
        fs.chmodSync(scriptPath, 0o755);
        counts.launchers++;
      } catch (e) {
        skippedLaunchers.push({ cmd: l.cmd, reason: e.message });
      }
    }
  }

  // 3. Codex Profiles
  const skippedProfiles = [];
  if (Array.isArray(bundle.codex_profiles)) {
    for (const pf of bundle.codex_profiles) {
      if (!pf.name || !pf.data) { skippedProfiles.push({ name: pf && pf.name, reason: '缺少 name 或 data' }); continue; }
      try {
        await codex.writeProfile(pf.name, pf.data);
        counts.profiles++;
      } catch (e) {
        skippedProfiles.push({ name: pf.name, reason: e.message });
      }
    }
  }

  // 4. Skills
  const skippedSkills = [];
  if (Array.isArray(bundle.skills)) {
    for (const sk of bundle.skills) {
      if (!sk.id || !sk.fullContent) { skippedSkills.push({ id: sk && sk.id, reason: '缺少 id 或内容' }); continue; }
      try {
        skills.saveSkill({
          id: sk.id,
          name: sk.name,
          description: sk.description,
          content: sk.fullContent,
          targets: Array.isArray(sk.targets) ? sk.targets : ['claude', 'codex']
        });
        counts.skills++;
      } catch (e) {
        skippedSkills.push({ id: sk.id, reason: e.message });
      }
    }
  }

  // 5. Rules（saveRule 只能写已存在的规则文件，新环境下的项目规则会被跳过）
  const skippedRules = [];
  if (Array.isArray(bundle.rules)) {
    for (const r of bundle.rules) {
      if (!r.id || !r.content) { skippedRules.push({ id: r && r.id, reason: '缺少 id 或内容' }); continue; }
      try {
        memory.saveRule(r.id, r.content);
        counts.rules++;
      } catch (e) {
        skippedRules.push({ id: r.id, reason: e.message });
      }
    }
  }

  return {
    ok: true,
    imported_at: new Date().toISOString(),
    counts,
    skipped: {
      launchers: skippedLaunchers,
      profiles: skippedProfiles,
      skills: skippedSkills,
      rules: skippedRules
    }
  };
}

module.exports = {
  exportBundle,
  importBundle
};
