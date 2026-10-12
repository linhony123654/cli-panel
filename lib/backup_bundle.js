'use strict';
const fs = require('fs');
const path = require('path');
const smolToml = require('smol-toml');
const store = require('./store');
const claude = require('./claude');
const codex = require('./codex');
const skills = require('./skills');
const memory = require('./memory');
const { HOME, PATHS, RE, atomicWrite, backup, readText, checkUrl, checkModel, cleanText, intOrNull } = require('./util');

const BUNDLE_VERSION = '1.2.0';
const MAX_SCRIPT = 64 * 1024;

function backupIfExists(p) {
  if (fs.existsSync(p)) backup(p);
}

function inside(parent, child) {
  const base = path.resolve(parent) + path.sep;
  return path.resolve(child).startsWith(base);
}

// 手写 codex 启动器没有 MARKER，parseCodexLauncher 认不出；靠 exec 行识别。
// 返回 null = 不是 codex 启动器；返回 '' = 是，但取不到合法 profile 名（只保留原文）。
function sniffCodexProfile(text) {
  if (!/^\s*exec\s+codex\b/m.test(text)) return null;
  const m = text.match(/\bcodex\s+-p\s+("[^"]*"|'[^']*'|\S+)/);
  if (!m) return '';
  const name = m[1].replace(/^['"]|['"]$/g, '');
  return RE.cmd.test(name) ? name : '';
}

// ---------------------------------------------------------------- export
function exportBundle() {
  const s = store.get() || store.load();
  const warnings = [];

  const providers = (s.providers || []).map(p => ({ ...p, key: store.readKey(p.id) }));

  // ~/.local/bin 下与面板相关的脚本分三类：claude 启动器、codex profile 启动器、默认别名。
  // claude.scan() 只认第一类（要求 exec env + ANTHROPIC_BASE_URL），另两类必须自己扫，
  // 否则新机上它们会被静默漏掉。
  const launchers = [];
  let binFiles = [];
  try { binFiles = fs.readdirSync(PATHS.bin); } catch { binFiles = []; }
  for (const f of binFiles) {
    if (!RE.cmd.test(f)) continue; // 跳过 .bak / __pycache__ 等
    const full = path.join(PATHS.bin, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_SCRIPT) continue; // 体积超限的一律不是启动器，静默跳过（go/uv 等二进制）
    const text = readText(full, '');
    if (!text.startsWith('#!')) continue;

    const parsed = claude.parseLauncher(text);
    const codexProfile = parsed ? null : (codex.parseCodexLauncher(text) || sniffCodexProfile(text));
    const aliasTarget = (parsed || codexProfile !== null) ? null : claude.parseAlias(text);
    if (!parsed && codexProfile === null && !aliasTarget) continue; // 与本面板无关的脚本，不碰

    launchers.push({
      cmd: f,
      kind: parsed ? 'claude' : (codexProfile !== null ? 'codex' : 'alias'),
      text,
      ...(parsed ? { form: { ...parsed, cmd: f, key_file: undefined } } : {}),
      ...(codexProfile !== null ? { profile: codexProfile } : {}),
      ...(aliasTarget ? { alias_target: aliasTarget } : {}),
    });
  }

  const profiles = codex.listProfiles();

  // codex profile 依赖 ~/.codex/config.toml 的 [model_providers.*] 与 catalog JSON，
  // 不带上这两样，新机上 profile 会全部校验失败。
  const catalogs = [];
  for (const c of codex.listCatalogs()) {
    try {
      catalogs.push({
        file: c.file,
        is_panel_managed: c.is_panel_managed,
        content: fs.readFileSync(c.path, 'utf8'),
      });
    } catch (e) {
      warnings.push(`catalog ${c.file}: ${e.message}`);
    }
  }
  let codexConfig = null;
  if (fs.existsSync(PATHS.codexConfig)) {
    try { codexConfig = readText(PATHS.codexConfig, ''); } catch (e) { warnings.push(`config.toml: ${e.message}`); }
  }

  const skList = skills.listSkills().map(sk => {
    // 多文件 skill 的附属资产不在包内，明确记一笔而不是假装完整。
    // 注意 sk.paths 的值是 ~ 前缀（skills.js 做过 replace(HOME,'~')），path.resolve 不认 ~，必须先还原。
    const extraDirs = new Map();
    for (const p of Object.values(sk.paths)) {
      const dir = path.dirname(path.join(HOME, p.replace(/^~(?=\/)/, '')));
      try {
        const extra = fs.readdirSync(dir).filter(f => f !== 'SKILL.md');
        if (extra.length) extraDirs.set(dir.replace(HOME, '~'), extra);
      } catch (e) {
        warnings.push(`skill ${sk.id}: 无法读取目录 ${p} (${e.code || e.message})`);
      }
    }
    if (extraDirs.size) {
      const detail = [...extraDirs].map(([d, f]) => `${d}: ${f.join(', ')}`).join(' | ');
      warnings.push(`skill ${sk.id}: 附属文件未导出 → ${detail}`);
    }
    return {
      id: sk.id,
      name: sk.name,
      description: sk.description,
      fullContent: sk.fullContent,
      targets: sk.targets,
    };
  });

  const rules = [];
  const rulesSkipped = [];
  for (const r of memory.listRules()) {
    try {
      rules.push({ id: r.id, name: r.name, path: r.path, content: memory.getRule(r.id).content });
    } catch (e) {
      rulesSkipped.push({ id: r.id, reason: e.message });
    }
  }

  // ~/.claude/settings.json 与 statusline.py 都由面板直接编辑，不带上的话新机没有设置与状态栏
  const readFileEntry = (p, label) => {
    if (!fs.existsSync(p)) return null;
    try { return { path: p.replace(HOME, '~'), content: readText(p, '') }; }
    catch (e) { warnings.push(`${label}: ${e.message}`); return null; }
  };
  const claudeSettings = readFileEntry(PATHS.claudeSettings, 'claude settings.json');
  const statuslineScript = readFileEntry(PATHS.statuslineScript, 'statusline.py');

  return {
    version: BUNDLE_VERSION,
    exported_at: new Date().toISOString(),
    alias: s.alias || { name: 'cl', target: '' },
    providers,
    launchers,
    codex_config: codexConfig,
    codex_catalogs: catalogs,
    codex_profiles: profiles,
    claude_settings: claudeSettings,
    statusline_script: statuslineScript,
    skills: skList,
    rules,
    export_warnings: warnings,
    export_skipped: { rules: rulesSkipped },
  };
}

// ---------------------------------------------------------------- import
async function importBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('无效的导入数据格式 (需要 JSON 对象)');
  }

  const counts = { providers: 0, launchers: 0, codex_config: 0, codex_catalogs: 0, profiles: 0, claude_settings: 0, statusline: 0, skills: 0, rules: 0 };
  const skipped = { providers: [], launchers: [], codex_config: [], codex_catalogs: [], profiles: [], claude_settings: [], statusline: [], skills: [], rules: [] };
  // 只登记形状对、能落盘的文件；形状不对的进 skipped，供调用方判断能否安全替换 settings.json
  let settingsRestorable = false;

  // 1. Providers（id 必须过 RE.id：它会拼进 key 文件名，不校验就是任意路径写入）
  if (Array.isArray(bundle.providers)) {
    const s = store.get() || store.load();
    for (const p of bundle.providers) {
      if (!p || !p.id || !p.name) { skipped.providers.push({ id: (p && p.id) || '(空)', reason: '缺少 id 或 name' }); continue; }
      if (!RE.id.test(p.id)) { skipped.providers.push({ id: p.id, reason: 'id 不合法（小写字母开头，仅字母/数字/_/-，≤32 位）' }); continue; }
      const keyFile = path.join(PATHS.keyDir, `${p.id}.key`);
      if (!inside(PATHS.keyDir, keyFile)) { skipped.providers.push({ id: p.id, reason: 'key 路径越界' }); continue; }
      if (p.key !== undefined && typeof p.key !== 'string') { skipped.providers.push({ id: p.id, reason: 'key 必须是字符串' }); continue; }

      // URL / 模型走与面板保存供应商同一套校验，否则会绕过 checkUrl/checkModel 写进启动器
      let anthropicUrl, openaiUrl, models;
      try {
        anthropicUrl = checkUrl(String(p.anthropic_url || '').trim(), 'Anthropic 接口地址');
        openaiUrl = checkUrl(String(p.openai_url || '').trim(), 'OpenAI Responses 接口地址');
        models = [];
        for (const m of (Array.isArray(p.models) ? p.models : [])) {
          const mid = checkModel(String(m.id || '').trim(), '模型 ID');
          if (!mid || models.some(x => x.id === mid)) continue;
          models.push({ id: mid, name: cleanText(m.name, 60), desc: cleanText(m.desc, 160), context: intOrNull(m.context, `${mid} 上下文`, 1000, 1e7) });
        }
      } catch (e) {
        skipped.providers.push({ id: p.id, reason: e.message });
        continue;
      }

      if (p.key) {
        try {
          store.writeKey(p.id, p.key);
        } catch (e) {
          skipped.providers.push({ id: p.id, reason: `写入密钥失败: ${e.message}` });
          continue;
        }
      } else if (p.key === '') {
        skipped.providers.push({ id: p.id, reason: '快照中该供应商没有 API Key（原机可能走环境变量），密钥未写入' });
      }
      const provData = {
        id: p.id,
        name: cleanText(p.name, 60) || p.id,
        anthropic_url: anthropicUrl,
        openai_url: openaiUrl,
        note: cleanText(p.note, 120) || '导入自配置包',
        models,
      };
      const idx = s.providers.findIndex(x => x.id === p.id);
      if (idx >= 0) s.providers[idx] = provData; else s.providers.push(provData);
      counts.providers++;
    }
    // 别名元数据；脚本本体在第 2 步按原文还原
    if (bundle.alias !== undefined) {
      const a = bundle.alias;
      if (!a || typeof a !== 'object' || Array.isArray(a)) {
        skipped.launchers.push({ cmd: '(alias)', reason: 'alias 不是对象' });
      } else if (!RE.cmd.test(String(a.name || ''))) {
        skipped.launchers.push({ cmd: '(alias)', reason: `别名名不合法: ${a.name}` });
      } else {
        const target = String(a.target || '');
        s.alias = { name: String(a.name), target: RE.cmd.test(target) ? target : '' };
      }
    }
    store.save();
  } else if (bundle.providers !== undefined) {
    skipped.providers.push({ id: '(providers)', reason: 'providers 不是数组，整段跳过' });
  }

  // 2. Launchers：优先按原文逐字还原（手写脚本无 # provider: 标记，重建不了）
  if (Array.isArray(bundle.launchers)) {
    const providers = (store.get() || store.load()).providers || [];
    for (const l of bundle.launchers) {
      if (!l || !l.cmd || !RE.cmd.test(l.cmd)) { skipped.launchers.push({ cmd: (l && l.cmd) || '(空)', reason: '命令名缺失或不合法' }); continue; }
      let script = null;
      if (typeof l.text === 'string' && l.text.startsWith('#!')) {
        script = l.text;
      } else if (!script && l.alias_target && RE.cmd.test(String(l.alias_target))) {
        script = claude.renderAlias(String(l.alias_target));
      } else if (l.kind === 'codex' || l.profile) {
        // profile 名非法时只保留原文（手写启动器可能指向本机没有的 profile）
        if (RE.cmd.test(String(l.profile || ''))) script = codex.renderCodexLauncher(String(l.profile));
      } else if (l.form) {
        // 旧版快照没有原文，退回用 form 重渲染（需要本地已有对应供应商）
        const prov = providers.find(x => x.id === l.form.provider);
        if (!prov) { skipped.launchers.push({ cmd: l.cmd, reason: `快照无原文，且本地无供应商 ${l.form.provider || '(空)'}` }); continue; }
        try {
          script = claude.render(claude.normalize({ ...l.form, cmd: l.cmd }, providers), prov);
        } catch (e) {
          skipped.launchers.push({ cmd: l.cmd, reason: e.message });
          continue;
        }
      } else {
        skipped.launchers.push({ cmd: l.cmd, reason: '缺少原文与可重建信息' });
        continue;
      }
      try {
        const scriptPath = path.join(PATHS.bin, l.cmd);
        if (!inside(PATHS.bin, scriptPath)) { skipped.launchers.push({ cmd: l.cmd, reason: '目标路径越界' }); continue; }
        fs.mkdirSync(PATHS.bin, { recursive: true });
        backupIfExists(scriptPath);
        atomicWrite(scriptPath, script);
        fs.chmodSync(scriptPath, 0o755);
        counts.launchers++;
      } catch (e) {
        skipped.launchers.push({ cmd: l.cmd, reason: e.message });
      }
    }
  }

  // 3. ~/.codex/config.toml —— 必须早于 profiles，否则 writeProfile 的校验必然失败
  let codexConfigOk = false;
  if (typeof bundle.codex_config === 'string' && bundle.codex_config.trim()) {
    try {
      smolToml.parse(bundle.codex_config);
      backupIfExists(PATHS.codexConfig);
      atomicWrite(PATHS.codexConfig, bundle.codex_config, 0o600);
      counts.codex_config = 1;
      codexConfigOk = true;
    } catch (e) {
      skipped.codex_config.push({ name: 'config.toml', reason: `TOML 解析失败: ${e.message}` });
    }
  } else if (bundle.codex_config === null || bundle.codex_config === undefined) {
    // 导出端没带上（原机就没有，或读取失败）。必须显式说明，
    // 否则下面的 profile 会因 config.toml 缺 [model_providers] 而全部失败，却看不出真正原因。
    skipped.codex_config.push({ name: 'config.toml', reason: '快照中不含 config.toml；profile 校验将依赖本机现有配置' });
  }
  if (!codexConfigOk && bundle.codex_config !== null && bundle.codex_config !== undefined) {
    skipped.codex_config.push({ name: 'config.toml', reason: '未还原，profile 可能校验失败' });
  }

  // 4. Catalog JSON（profile 的 model_catalog_json 指向它们）
  if (Array.isArray(bundle.codex_catalogs)) {
    for (const c of bundle.codex_catalogs) {
      if (!c || !c.file || typeof c.content !== 'string') { skipped.codex_catalogs.push({ name: (c && c.file) || '(空)', reason: '缺少文件名或内容' }); continue; }
      if (!/^[A-Za-z0-9._-]+\.json$/.test(c.file)) { skipped.codex_catalogs.push({ name: c.file, reason: '文件名不合法' }); continue; }
      const dir = c.is_panel_managed ? PATHS.catalogDir : PATHS.codexHome;
      const full = path.join(dir, c.file);
      if (!inside(dir, full)) { skipped.codex_catalogs.push({ name: c.file, reason: '路径越界' }); continue; }
      try {
        JSON.parse(c.content);
        fs.mkdirSync(dir, { recursive: true });
        backupIfExists(full);
        atomicWrite(full, c.content);
        counts.codex_catalogs++;
      } catch (e) {
        skipped.codex_catalogs.push({ name: c.file, reason: e.message });
      }
    }
  }

  // 5. ~/.claude/settings.json 与 statusline.py（面板可直接编辑，需随包还原）
  if (bundle.claude_settings && typeof bundle.claude_settings === 'object' && typeof bundle.claude_settings.content === 'string') {
    const content = bundle.claude_settings.content;
    try {
      JSON.parse(content); // 形状不对就不写：面板全靠这个文件，写坏了整个设置页就废了
      settingsRestorable = true;
      backupIfExists(PATHS.claudeSettings);
      atomicWrite(PATHS.claudeSettings, content, 0o644);
      counts.claude_settings = 1;
    } catch (e) {
      skipped.claude_settings.push({ name: 'settings.json', reason: `JSON 解析失败: ${e.message}` });
    }
  } else if (bundle.claude_settings !== undefined && bundle.claude_settings !== null) {
    skipped.claude_settings.push({ name: 'settings.json', reason: '缺少 content 字段' });
  }
  if (bundle.statusline_script && typeof bundle.statusline_script === 'object' && typeof bundle.statusline_script.content === 'string') {
    const content = bundle.statusline_script.content;
    try {
      backupIfExists(PATHS.statuslineScript);
      atomicWrite(PATHS.statuslineScript, content, 0o755);
      counts.statusline = 1;
    } catch (e) {
      skipped.statusline.push({ name: 'statusline.py', reason: e.message });
    }
  }

  // 6. Codex Profiles
  if (Array.isArray(bundle.codex_profiles)) {
    for (const pf of bundle.codex_profiles) {
      if (!pf || !pf.name || !pf.data) { skipped.profiles.push({ name: (pf && pf.name) || '(空)', reason: '缺少 name 或 data' }); continue; }
      try {
        await codex.writeProfile(pf.name, pf.data);
        counts.profiles++;
      } catch (e) {
        skipped.profiles.push({ name: pf.name, reason: e.message });
      }
    }
  }

  // 7. Skills：逐字写回 fullContent，不走 serializeSkill 重排（那会丢掉额外 frontmatter 键）
  if (Array.isArray(bundle.skills)) {
    for (const sk of bundle.skills) {
      if (!sk || !sk.id || !/^[a-zA-Z0-9_-]+$/.test(sk.id)) { skipped.skills.push({ id: (sk && sk.id) || '(空)', reason: 'id 缺失或不合法' }); continue; }
      if (typeof sk.fullContent !== 'string' || !sk.fullContent.trim()) { skipped.skills.push({ id: sk.id, reason: '缺少内容' }); continue; }
      const targets = (Array.isArray(sk.targets) ? sk.targets : ['claude', 'codex'])
        .filter(t => Object.prototype.hasOwnProperty.call(skills.DIRS, t));
      if (!targets.length) { skipped.skills.push({ id: sk.id, reason: `无有效目标 (${(sk.targets || []).join(',') || '空'})` }); continue; }
      let wrote = 0;
      const failures = [];
      for (const t of targets) {
        const skillPath = path.join(skills.DIRS[t], sk.id, 'SKILL.md');
        try {
          fs.mkdirSync(path.dirname(skillPath), { recursive: true });
          backupIfExists(skillPath);
          atomicWrite(skillPath, sk.fullContent);
          wrote++;
        } catch (e) {
          failures.push(`${t}: ${e.message}`);
        }
      }
      if (wrote) counts.skills++;
      else skipped.skills.push({ id: sk.id, reason: failures.join('; ') || '未写入任何文件' });
    }
  }

  // 8. Rules（saveRule 只能写本机已存在的规则文件，新环境下的项目规则会被跳过）
  if (Array.isArray(bundle.rules)) {
    for (const r of bundle.rules) {
      if (!r || !r.id || !r.content) { skipped.rules.push({ id: (r && r.id) || '(空)', reason: '缺少 id 或内容' }); continue; }
      try {
        memory.saveRule(r.id, r.content);
        counts.rules++;
      } catch (e) {
        skipped.rules.push({ id: r.id, reason: e.message });
      }
    }
  }

  const skippedTotal = Object.values(skipped).reduce((n, arr) => n + arr.length, 0);
  return {
    ok: skippedTotal === 0,
    bundle_version: bundle.version || '(未标注)',
    imported_at: new Date().toISOString(),
    counts,
    skipped,
    skipped_total: skippedTotal,
    // settings.json 只在快照里带且形状正确时才写；没写就让调用方按本机现值重新渲染表单，
    // 否则表单会显示「空值」，用户一保存就把真实设置抹掉。
    settings_restored: settingsRestorable,
  };
}

module.exports = { BUNDLE_VERSION, exportBundle, importBundle };
