'use strict';
// 面板自身的数据：供应商（含模型清单）、Claude 启动器表单。密钥单独存 ~/.config/cli-panel/keys/<id>.key
const fs = require('fs');
const path = require('path');
const { DATA, PATHS, atomicWrite, readText, RE, checkUrl, checkModel, intOrNull, cleanText, mask } = require('./util');
const claude = require('./claude');
const codex = require('./codex');

const STORE_FILE = path.join(DATA, 'store.json');
let store = null;

function load() {
  try { store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { store = null; }
  if (!store) { store = { providers: [], alias: { name: 'cl', target: '' } }; bootstrap(); save(); }
  store.alias = store.alias || { name: 'cl', target: '' };
  return store;
}

function save() { atomicWrite(STORE_FILE, JSON.stringify(store, null, 2)); }
function get() { return store; }

function keyPath(id) { return path.join(PATHS.keyDir, `${id}.key`); }
function readKey(id) { const t = readText(keyPath(id)); return t ? t.split('\n')[0].trim() : ''; }
function writeKey(id, key) {
  fs.mkdirSync(PATHS.keyDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(PATHS.keyDir, 0o700);
  atomicWrite(keyPath(id), key + '\n', 0o600);
}

function slug(s) {
  const x = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return /^[a-z]/.test(x) ? x : 'p-' + (x || Date.now().toString(36));
}

function uniqueId(base) {
  let id = base, i = 2;
  while (store.providers.some(p => p.id === id)) id = `${base}-${i++}`;
  return id;
}

function addModels(prov, ids) {
  for (const id of ids) if (id && RE.model.test(id) && !prov.models.some(m => m.id === id)) prov.models.push({ id, name: '', desc: '', context: null });
}

// 首次启动：从现有 Codex 配置与 Claude 启动器导入供应商（只写面板自己的数据，不动 CLI 文件）
function bootstrap() {
  const cfg = (() => { try { return codex.readConfig(); } catch { return {}; } })();
  for (const [id, v] of Object.entries(cfg.model_providers || {})) {
    if (!RE.id.test(id) || !v.base_url || !v.experimental_bearer_token) continue;
    store.providers.push({ id, name: v.name && v.name !== 'OpenAI' ? v.name : id, anthropic_url: '', openai_url: String(v.base_url).replace(/\/+$/, ''), models: [], note: '从 Codex 配置导入' });
    writeKey(id, v.experimental_bearer_token);
  }
  for (const l of claude.scan()) {
    const p = l.parsed;
    const key = p.key_file ? (readText(p.key_file) || '').split('\n')[0].trim() : '';
    let host = '';
    try { host = new URL(p.base_url).host; } catch { continue; }
    let prov = store.providers.find(x => x.anthropic_url === p.base_url && readKey(x.id) === key)
      || store.providers.find(x => !x.anthropic_url && x.openai_url && new URL(x.openai_url).host === host && readKey(x.id) === key);
    if (!prov) {
      prov = { id: uniqueId(slug(host.split('.').slice(-2, -1)[0] || host)), name: host, anthropic_url: '', openai_url: '', models: [], note: `从 ${l.cmd} 导入` };
      store.providers.push(prov);
      if (key) writeKey(prov.id, key);
    }
    prov.anthropic_url = prov.anthropic_url || p.base_url;
    addModels(prov, claude.MODEL_FIELDS.map(f => p[f]));
  }
  for (const pf of codex.listProfiles()) {
    const prov = store.providers.find(x => x.id === pf.data?.model_provider);
    if (prov && pf.data.model) addModels(prov, [pf.data.model]);
  }
}

function publicProviders() {
  return store.providers.map(p => {
    const k = readKey(p.id);
    return { ...p, key_mask: mask(k), has_key: !!k };
  });
}

function normalizeProvider(input) {
  const isNew = !input.id;
  const name = cleanText(input.name, 40);
  if (!name) throw new Error('供应商名称必填');
  const id = isNew ? uniqueId(slug(input.new_id || name)) : String(input.id);
  if (!RE.id.test(id)) throw new Error('供应商 ID 不合法');
  const p = {
    id, name,
    anthropic_url: checkUrl(String(input.anthropic_url || '').trim(), 'Anthropic 接口地址'),
    openai_url: checkUrl(String(input.openai_url || '').trim(), 'OpenAI Responses 接口地址'),
    note: cleanText(input.note, 120),
    models: [],
  };
  if (!p.anthropic_url && !p.openai_url) throw new Error('至少填一个接口地址（Claude Code 用 Anthropic，Codex 用 Responses）');
  for (const m of input.models || []) {
    const mid = checkModel(String(m.id || '').trim(), '模型 ID');
    if (!mid || p.models.some(x => x.id === mid)) continue;
    p.models.push({ id: mid, name: cleanText(m.name, 60), desc: cleanText(m.desc, 160), context: intOrNull(m.context, `${mid} 上下文`, 1000, 1e7) });
  }
  const key = String(input.key || '').trim();
  if (key && (/\s/.test(key) || key.length > 512)) throw new Error('Key 含空白字符或过长');
  if (isNew && !key) throw new Error('新供应商需要填写 Key');
  return { p, key, isNew };
}

module.exports = { load, save, get, readKey, writeKey, keyPath, publicProviders, normalizeProvider, slug, uniqueId, addModels };
