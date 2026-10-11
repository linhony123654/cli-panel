'use strict';
// Codex：config.toml / <profile>.config.toml / 模型目录 JSON
const fs = require('fs');
const os = require('os');
const path = require('path');
const TOML = require('smol-toml');
const { PATHS, HOME, atomicWrite, backup, readText, run, RE, checkModel, intOrNull, shq, cleanText } = require('./util');

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// 「设为默认」时从 profile 复制到 config.toml 顶层的键
const SWITCH_KEYS = ['model', 'model_provider', 'model_reasoning_effort', 'model_catalog_json', 'model_context_window', 'model_auto_compact_token_limit'];
const MARKER = '# managed-by: cli-panel';
const MASK_PREFIX = '••••';

function readConfig() {
  const src = readText(PATHS.codexConfig, '');
  return src ? TOML.parse(src) : {};
}

function profileFile(name) { return path.join(PATHS.codexHome, `${name}.config.toml`); }

function listProfiles() {
  let files = [];
  try { files = fs.readdirSync(PATHS.codexHome); } catch { return []; }
  return files.filter(f => f.endsWith('.config.toml')).map(f => {
    const name = f.slice(0, -'.config.toml'.length);
    const raw = readText(path.join(PATHS.codexHome, f), '');
    let data = null, error = null;
    try { data = TOML.parse(raw); } catch (e) { error = e.message; }
    return { name, valid: PROFILE_RE.test(name), data, error };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function providerList(cfg) {
  const mp = cfg.model_providers || {};
  return Object.entries(mp).map(([id, v]) => ({
    id,
    name: v.name || id,
    base_url: v.base_url || '',
    wire_api: v.wire_api || '',
    auth: v.experimental_bearer_token ? 'bearer' : v.env_key ? `env:${v.env_key}` : 'none',
  }));
}

// 用临时 CODEX_HOME 让真实 codex 校验配置（枚举值、类型都会被检查）
async function validate(configText, profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-panel-codex-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.toml'), configText, { mode: 0o600 });
    const args = [];
    if (profile) {
      fs.writeFileSync(path.join(dir, `${profile.name}.config.toml`), profile.text, { mode: 0o600 });
      args.push('-p', profile.name);
    }
    args.push('debug', 'prompt-input', 'ping');
    const r = await run('codex', args, { timeout: 30000, cwd: dir, env: { ...process.env, CODEX_HOME: dir } });
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', 'g'), '').trim();
      throw new Error('Codex 拒绝了这份配置：' + msg.split('\n').filter(Boolean).slice(0, 3).join(' '));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function writeConfig(cfg) {
  const text = TOML.stringify(cfg) + '\n';
  await validate(text);
  const bk = backup(PATHS.codexConfig);
  atomicWrite(PATHS.codexConfig, text, 0o600);
  return bk;
}

async function writeProfile(name, data) {
  if (!PROFILE_RE.test(name)) throw new Error('profile 名不合法');
  const text = TOML.stringify(data) + '\n';
  await validate(readText(PATHS.codexConfig, ''), { name, text });
  const file = profileFile(name);
  const bk = backup(file);
  atomicWrite(file, text, 0o600);
  return bk;
}

// ---- 密钥打码（raw 编辑器用） ----
function maskConfig(cfg) {
  const c = structuredClone(cfg);
  for (const v of Object.values(c.model_providers || {})) {
    if (v.experimental_bearer_token) v.experimental_bearer_token = MASK_PREFIX + String(v.experimental_bearer_token).slice(-4);
  }
  return c;
}

function unmaskConfig(next, orig) {
  for (const [id, v] of Object.entries(next.model_providers || {})) {
    const t = v.experimental_bearer_token;
    if (typeof t === 'string' && t.startsWith(MASK_PREFIX)) {
      const o = orig.model_providers?.[id]?.experimental_bearer_token;
      if (!o || MASK_PREFIX + String(o).slice(-4) !== t) throw new Error(`model_providers.${id} 的 token 是打码值，但原配置里找不到对应密钥，请填写真实值`);
      v.experimental_bearer_token = o;
    }
  }
  return next;
}

// ---- 供应商同步：面板供应商 → [model_providers.<id>] ----
function syncProvider(cfg, prov, key) {
  if (!prov.openai_url) return false;
  cfg.model_providers = cfg.model_providers || {};
  const cur = cfg.model_providers[prov.id] || {};
  // 已存在的条目保留 name 等字段（cliproxyapi 的 name="OpenAI" 等可能影响行为）
  const next = { ...cur, name: cur.name || prov.name, base_url: prov.openai_url, wire_api: cur.wire_api || 'responses' };
  if (key) { next.experimental_bearer_token = key; delete next.env_key; }
  cfg.model_providers[prov.id] = next;
  return true;
}

function profileRefs(cfg, providerId) {
  const refs = [];
  if (cfg.model_provider === providerId) refs.push('config.toml（当前默认）');
  for (const p of listProfiles()) if (p.data?.model_provider === providerId) refs.push(`profile ${p.name}`);
  return refs;
}

// ---- 模型目录 ----
function templateEntry() {
  for (const f of ['claude-models.json', 'gpt-6-models.json', 'kimi-models.json', 'models.json']) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(PATHS.codexHome, f), 'utf8'));
      if (d.models?.[0]) return d.models[0];
    } catch { /* 下一个 */ }
  }
  return null;
}

function writeCatalog(name, models) {
  return saveCatalog(name, models).path;
}

function saveCatalog(target, models) {
  let fullPath;
  if (target.startsWith('/') || target.startsWith('~')) {
    fullPath = target.replace(/^~(?=\/)/, HOME);
  } else {
    const fname = target.endsWith('.json') ? target : `${target}.json`;
    fullPath = path.join(PATHS.catalogDir, fname);
  }
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tpl = templateEntry();
  if (!tpl) throw new Error('找不到可作模板的 Codex 模型目录（~/.codex/*-models.json）');

  let existingModels = [];
  try {
    existingModels = JSON.parse(fs.readFileSync(fullPath, 'utf8')).models || [];
  } catch {}

  const list = (models || []).map((m, i) => {
    const slug = m.id || m.slug;
    const existing = existingModels.find(em => em.slug === slug);
    const e = existing ? structuredClone(existing) : structuredClone(tpl);
    e.slug = slug;
    e.display_name = m.name || m.display_name || slug;
    e.description = m.desc || m.description || e.description || `${e.display_name}（CLI 配置面板生成）`;
    if (m.effort) e.default_reasoning_level = m.effort;
    const ctx = m.context || e.context_window || tpl.context_window || 262144;
    e.context_window = ctx;
    e.max_context_window = Math.max(ctx, e.max_context_window || 0);
    e.priority = i + 1;
    e.upgrade = null;
    e.availability_nux = null;
    return e;
  });

  backup(fullPath);
  atomicWrite(fullPath, JSON.stringify({ models: list }, null, 2) + '\n', 0o644);
  return { path: fullPath, shortPath: fullPath.replace(HOME, '~'), file: path.basename(fullPath), count: list.length };
}

function listCatalogs() {
  const dirs = [PATHS.codexHome, PATHS.catalogDir];
  const seen = new Set();
  const res = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    let files = [];
    try { files = fs.readdirSync(d); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      if (['auth.json', 'version.json'].includes(f)) continue;
      const fullPath = path.join(d, f);
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      try {
        const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (Array.isArray(content.models) && content.models.length > 0) {
          res.push({
            name: f.replace(/\.json$/, ''),
            file: f,
            path: fullPath,
            shortPath: fullPath.replace(HOME, '~'),
            is_panel_managed: fullPath.startsWith(PATHS.catalogDir),
            models: content.models.map(m => ({
              id: m.slug,
              slug: m.slug,
              name: m.display_name || m.slug,
              desc: m.description || '',
              effort: m.default_reasoning_level || 'high',
              context: m.context_window || 262144,
            }))
          });
        }
      } catch (e) {}
    }
  }
  return res.sort((a, b) => a.file.localeCompare(b.file));
}

function catalogSlugs(file) {
  try {
    const f = file.replace(/^~(?=\/)/, HOME);
    return JSON.parse(fs.readFileSync(f, 'utf8')).models.map(m => m.slug);
  } catch { return null; }
}

function catalogDetails(file) {
  try {
    const f = file.replace(/^~(?=\/)/, HOME);
    const content = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (content.models || []).map(m => ({
      id: m.slug,
      slug: m.slug,
      name: m.display_name || m.slug,
      desc: m.description || '',
      effort: m.default_reasoning_level || 'high',
      context: m.context_window || 262144,
    }));
  } catch { return []; }
}

// ---- profile 表单 ----
const EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const TIERS = ['', 'fast', 'priority'];

function profileToForm(name, data, cfg) {
  const cat = data.model_catalog_json || '';
  const gen = path.join(PATHS.catalogDir, `${name}.json`);
  return {
    name,
    model: data.model || '',
    model_provider: data.model_provider || '',
    effort: data.model_reasoning_effort || '',
    service_tier: data.service_tier || '',
    context: data.model_context_window || '',
    compact: data.model_auto_compact_token_limit || '',
    catalog_mode: !cat ? 'none' : cat === gen ? 'generate' : 'path',
    catalog_path: cat,
    catalog_models: cat ? (catalogSlugs(cat) || []) : [],
    extra_keys: Object.keys(data).filter(k => !['model', 'model_provider', 'model_reasoning_effort', 'service_tier', 'model_context_window', 'model_auto_compact_token_limit', 'model_catalog_json'].includes(k)),
    is_default: !!data.model && cfg.model === data.model && cfg.model_provider === (data.model_provider || cfg.model_provider),
  };
}

function normalizeProfile(input, cfg) {
  const name = String(input.name || '').trim();
  if (!PROFILE_RE.test(name)) throw new Error('profile 名只能用小写字母、数字、- _，最多 32 位');
  const model = checkModel(String(input.model || '').trim(), '模型', false);
  const provider = String(input.model_provider || '').trim();
  if (!cfg.model_providers?.[provider]) throw new Error(`Codex 里没有供应商「${provider}」`);
  if (!EFFORTS.includes(input.effort || '')) throw new Error('推理强度不合法');
  if (!TIERS.includes(input.service_tier || '')) throw new Error('service_tier 不合法');
  const mode = ['none', 'generate', 'path'].includes(input.catalog_mode) ? input.catalog_mode : 'none';
  const catModels = [];
  for (const m of input.catalog_models || []) {
    const id = checkModel(String(m).trim(), '目录模型');
    if (id && !catModels.includes(id)) catModels.push(id);
  }
  if (mode === 'generate' && !catModels.includes(model)) catModels.unshift(model);
  let catPath = '';
  if (mode === 'path') {
    catPath = String(input.catalog_path || '').trim().replace(/^~(?=\/)/, HOME);
    if (!catPath.startsWith(PATHS.codexHome + '/') || !catPath.endsWith('.json')) throw new Error('目录文件须是 ~/.codex/ 下的 .json');
    if (!fs.existsSync(catPath)) throw new Error('目录文件不存在：' + catPath);
  }
  const cmd = String(input.cmd || '').trim();
  if (cmd && !RE.cmd.test(cmd)) throw new Error('命令名只能用小写字母、数字、-');
  return {
    name, model, provider, mode, catModels, catPath, cmd,
    effort: input.effort || '',
    service_tier: input.service_tier || '',
    context: intOrNull(input.context, '上下文窗口', 1000, 1e7),
    compact: intOrNull(input.compact, '自动压缩阈值', 1000, 1e7),
  };
}

function buildProfileData(existing, n, catalogFile) {
  const d = { ...existing };
  d.model = n.model;
  d.model_provider = n.provider;
  const setOrDel = (k, v) => { if (v === '' || v == null) delete d[k]; else d[k] = v; };
  setOrDel('model_reasoning_effort', n.effort);
  setOrDel('service_tier', n.service_tier);
  setOrDel('model_context_window', n.context);
  setOrDel('model_auto_compact_token_limit', n.compact);
  setOrDel('model_catalog_json', catalogFile || '');
  // 保持 TOML 里简单键在表之前，便于阅读
  const simple = {}, tables = {};
  for (const [k, v] of Object.entries(d)) (v && typeof v === 'object' && !Array.isArray(v) ? tables : simple)[k] = v;
  return { ...simple, ...tables };
}

function renderCodexLauncher(name) {
  return ['#!/usr/bin/env bash', MARKER, `# Codex profile 启动器 → ~/.codex/${name}.config.toml`, `exec codex -p ${shq(name)} "$@"`, ''].join('\n');
}

function parseCodexLauncher(text) {
  if (!text || !text.includes(MARKER)) return null;
  const m = text.match(/^exec codex -p '([a-z0-9_-]+)' "\$@"$/m);
  return m ? m[1] : null;
}

// ---- 全局设置表单 ----
const GLOBAL_FIELDS = {
  approval_policy: { type: 'enum', options: ['untrusted', 'on-failure', 'on-request', 'never'] },
  sandbox_mode: { type: 'enum', options: ['read-only', 'workspace-write', 'danger-full-access'] },
  model_reasoning_effort: { type: 'enum', options: EFFORTS.slice(1) },
  service_tier: { type: 'enum', options: TIERS.slice(1) },
  model_verbosity: { type: 'enum', options: ['low', 'medium', 'high'] },
  model_reasoning_summary: { type: 'enum', options: ['auto', 'concise', 'detailed', 'none'] },
  web_search: { type: 'enum', options: ['disabled', 'cached', 'indexed', 'live'] },
  personality: { type: 'enum', options: ['none', 'friendly', 'pragmatic'] },
  file_opener: { type: 'enum', options: ['vscode', 'vscode-insiders', 'windsurf', 'cursor', 'none'] },
  hide_agent_reasoning: { type: 'bool' },
  show_raw_agent_reasoning: { type: 'bool' },
  model_auto_compact_token_limit: { type: 'int' },
  model_context_window: { type: 'int' },
  model_catalog_json: { type: 'string' },
};

function globalsToForm(cfg) {
  const f = {};
  for (const k of Object.keys(GLOBAL_FIELDS)) f[k] = cfg[k] ?? '';
  f.notify_enabled = Array.isArray(cfg.notify) && cfg.notify.length > 0;
  f.notify = Array.isArray(cfg.notify) ? cfg.notify : [];
  f.agents_enabled = cfg.agents?.enabled ?? '';
  return f;
}

function applyGlobals(cfg, input) {
  for (const [k, spec] of Object.entries(GLOBAL_FIELDS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (v === '' || v == null) { delete cfg[k]; continue; }
    if (spec.type === 'enum') {
      if (!spec.options.includes(v)) throw new Error(`${k} 不支持「${v}」`);
      cfg[k] = v;
    } else if (spec.type === 'bool') cfg[k] = !!v;
    else if (spec.type === 'string') cfg[k] = String(v).trim();
    else cfg[k] = intOrNull(v, k, 1000, 1e7);
  }
  if ('notify_enabled' in input) {
    if (input.notify_enabled) {
      if (!cfg.notify?.length) cfg.notify = ['/home/ubuntu/bin/notify'];
    } else delete cfg.notify;
  }
  if ('agents_enabled' in input) {
    if (input.agents_enabled === '' || input.agents_enabled == null) { if (cfg.agents) delete cfg.agents.enabled; }
    else { cfg.agents = cfg.agents || {}; cfg.agents.enabled = !!input.agents_enabled; }
    if (cfg.agents && !Object.keys(cfg.agents).length) delete cfg.agents;
  }
  return cfg;
}

module.exports = {
  PROFILE_RE, SWITCH_KEYS, MARKER, EFFORTS, TIERS, GLOBAL_FIELDS,
  readConfig, listProfiles, providerList, validate, writeConfig, writeProfile, profileFile,
  maskConfig, unmaskConfig, syncProvider, profileRefs, writeCatalog, saveCatalog, listCatalogs,
  catalogSlugs, catalogDetails,
  profileToForm, normalizeProfile, buildProfileData, renderCodexLauncher, parseCodexLauncher,
  globalsToForm, applyGlobals, cleanText,
};
