'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./lib/util');
const auth = require('./lib/auth');
const store = require('./lib/store');
const claude = require('./lib/claude');
const codex = require('./lib/codex');
const ping = require('./lib/ping');
const sessions = require('./lib/sessions');
const skills = require('./lib/skills');
const mcp = require('./lib/mcp');
const git = require('./lib/git');
const usage = require('./lib/usage');
const memory = require('./lib/memory');
const doctor = require('./lib/doctor');
const system = require('./lib/system');
const logs = require('./lib/logs');
const cleaner = require('./lib/cleaner');

const PORT = Number(process.env.PORT || 9099);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const COOKIE = 'clipanel';

// ---------------------------------------------------------------- helpers
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new HttpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  // 只信任本机反代传来的 X-Forwarded-For
  const remote = req.socket.remoteAddress || '';
  if ((remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return remote;
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https';
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  // Vue 全局构建在运行时编译 DOM 模板，需要 unsafe-eval；不加载任何外部资源
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/vue.js': [path.join('..', 'node_modules', 'vue', 'dist', 'vue.global.prod.js'), 'application/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

// ---------------------------------------------------------------- state builders
function claudeState() {
  const launchers = claude.scan().map(l => ({
    cmd: l.cmd,
    managed: l.parsed.managed,
    form: { ...l.parsed, cmd: l.cmd, key_file: undefined },
    key_source: l.parsed.managed ? null : (l.parsed.key_file || '').replace(U.HOME, '~'),
  })).sort((a, b) => a.cmd.localeCompare(b.cmd));
  const st = store.get();
  const aliasPath = path.join(U.PATHS.bin, st.alias.name);
  const aliasTarget = claude.parseAlias(U.readText(aliasPath));
  return {
    launchers,
    alias: { name: st.alias.name, target: aliasTarget || '', exists: fs.existsSync(aliasPath) },
    efforts: claude.EFFORTS,
  };
}

const CLAUDE_SETTINGS = {
  model: { type: 'str' },
  'permissions.defaultMode': { type: 'enum', options: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] },
  alwaysThinkingEnabled: { type: 'bool' },
  autoCompactEnabled: { type: 'bool' },
  includeCoAuthoredBy: { type: 'bool' },
  includeGitInstructions: { type: 'bool' },
  respectGitignore: { type: 'bool' },
  skipDangerousModePermissionPrompt: { type: 'bool' },
  spinnerTipsEnabled: { type: 'bool' },
  verbose: { type: 'bool' },
  autoUpdates: { type: 'bool' },
  cleanupPeriodDays: { type: 'int', min: 1, max: 3650 },
  outputStyle: { type: 'str' },
  language: { type: 'str' },
  'statusLine.type': { type: 'str' },
  'statusLine.command': { type: 'str' },
  'env.API_TIMEOUT_MS': { type: 'envint', min: 1000, max: 1e8 },
  'env.DISABLE_AUTOUPDATER': { type: 'envbool' },
  'env.MAX_THINKING_TOKENS': { type: 'envint', min: 1000, max: 1e8 },
  'env.BASH_DEFAULT_TIMEOUT_MS': { type: 'envint', min: 1000, max: 1e8 },
  'env.CLAUDE_STATUS_CONTEXT_WINDOW': { type: 'envint', min: 1000, max: 1e8 },
  'env.CLAUDE_STATUS_TRIGGER': { type: 'envint', min: 1000, max: 1e8 },
};

function readClaudeSettings() {
  const raw = U.readText(U.PATHS.claudeSettings, '{}');
  try { return { raw, data: JSON.parse(raw) }; } catch (e) { return { raw, data: null, error: e.message }; }
}

function getPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, p, v) {
  const ks = p.split('.');
  let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
  if (v === undefined) delete o[ks.at(-1)]; else o[ks.at(-1)] = v;
  if (ks.length > 1 && !Object.keys(o).length) setPath(obj, ks.slice(0, -1).join('.'), undefined);
}

function claudeSettingsForm(data) {
  const f = {};
  for (const [k, spec] of Object.entries(CLAUDE_SETTINGS)) {
    const v = getPath(data, k);
    if (spec.type === 'envbool') f[k] = v === undefined ? '' : v === '1' || v === 'true';
    else if (spec.type === 'envint') f[k] = v ?? '';
    else f[k] = v ?? '';
  }
  f['statusLine_enabled'] = !!(data.statusLine && data.statusLine.command);
  if (!f['statusLine.command']) {
    f['statusLine.command'] = 'python3 /home/ubuntu/.claude/statusline.py';
  }
  return f;
}

function applyClaudeSettings(data, input) {
  for (const [k, spec] of Object.entries(CLAUDE_SETTINGS)) {
    if (!(k in input)) continue;
    let v = input[k];
    if (v === '' || v == null) { setPath(data, k, undefined); continue; }
    if (spec.type === 'enum' && !spec.options.includes(v)) throw new HttpError(400, `${k} 不支持「${v}」`);
    if (spec.type === 'bool') v = !!v;
    if (spec.type === 'int') v = U.intOrNull(v, k, spec.min, spec.max);
    if (spec.type === 'str') v = U.cleanText(v, 200);
    if (spec.type === 'envint') v = String(U.intOrNull(v, k, spec.min, spec.max));
    if (spec.type === 'envbool') v = v ? '1' : '0';
    setPath(data, k, v);
  }
  if ('statusLine_enabled' in input) {
    if (input.statusLine_enabled && input['statusLine.command']) {
      data.statusLine = {
        type: 'command',
        command: String(input['statusLine.command']).trim()
      };
    } else if (!input.statusLine_enabled) {
      delete data.statusLine;
    }
  }
  return data;
}

function writeClaudeSettings(data) {
  U.backup(U.PATHS.claudeSettings);
  U.atomicWrite(U.PATHS.claudeSettings, JSON.stringify(data, null, 2) + '\n', 0o644);
}

function codexState() {
  const cfg = codex.readConfig();
  const launchers = {};
  try {
    for (const f of fs.readdirSync(U.PATHS.bin)) {
      if (!U.RE.cmd.test(f)) continue;
      const name = codex.parseCodexLauncher(U.readText(path.join(U.PATHS.bin, f)));
      if (name) (launchers[name] = launchers[name] || []).push(f);
    }
  } catch { /* 忽略 */ }
  const profiles = codex.listProfiles().map(p => p.data
    ? { ...codex.profileToForm(p.name, p.data, cfg), valid: p.valid, launchers: launchers[p.name] || [] }
    : { name: p.name, error: p.error, valid: false, launchers: [] });
  const currentCatalog = cfg.model_catalog_json || '';
  const catalogs = codex.listCatalogs();
  return {
    current: {
      model: cfg.model || '',
      model_provider: cfg.model_provider || '',
      effort: cfg.model_reasoning_effort || '',
      catalog: currentCatalog,
      catalog_models: currentCatalog ? codex.catalogDetails(currentCatalog) : [],
    },
    catalogs,
    providers: codex.providerList(cfg),
    profiles,
    globals: codex.globalsToForm(cfg),
    global_fields: codex.GLOBAL_FIELDS,
    efforts: codex.EFFORTS,
    tiers: codex.TIERS,
  };
}

function fullState() {
  const cs = readClaudeSettings();
  return {
    providers: store.publicProviders(),
    claude: claudeState(),
    claude_settings: { form: cs.data ? claudeSettingsForm(cs.data) : null, error: cs.error || null, fields: CLAUDE_SETTINGS },
    codex: codexState(),
    sessions: sessions.listSessions(),
    skills: skills.listSkills(),
    mcp: mcp.listMcpServers(),
    host: os.hostname(),
  };
}

// ---------------------------------------------------------------- actions
function writeLauncher(cmd, text) {
  const file = path.join(U.PATHS.bin, cmd);
  const bk = U.backup(file);
  U.atomicWrite(file, text, 0o755);
  return bk;
}

function regenerateForProvider(provId) {
  const done = [];
  const prov = store.get().providers.find(p => p.id === provId);
  for (const l of claude.scan()) {
    if (!l.parsed.managed || l.parsed.provider !== provId) continue;
    if (!prov.anthropic_url) continue;
    const form = { ...l.parsed, cmd: l.cmd };
    const n = claude.normalize(form, store.get().providers);
    const text = claude.render(n, prov);
    if (text !== l.text) { writeLauncher(l.cmd, text); done.push(l.cmd); }
  }
  return done;
}

async function saveProvider(body) {
  const { p, key, isNew } = store.normalizeProvider(body);
  const st = store.get();
  const idx = st.providers.findIndex(x => x.id === p.id);
  if (!isNew && idx < 0) throw new HttpError(404, '供应商不存在');
  if (key) store.writeKey(p.id, key);
  if (idx >= 0) st.providers[idx] = p; else st.providers.push(p);
  store.save();
  const result = { id: p.id, regenerated: regenerateForProvider(p.id), codex_synced: false };
  // 同步到 Codex：只有填了 Responses 地址才写 [model_providers.<id>]
  if (p.openai_url) {
    const cfg = codex.readConfig();
    const before = JSON.stringify(cfg.model_providers?.[p.id] || null);
    codex.syncProvider(cfg, p, store.readKey(p.id));
    if (JSON.stringify(cfg.model_providers[p.id]) !== before) { await codex.writeConfig(cfg); result.codex_synced = true; }
  }
  return result;
}

async function deleteProvider(id) {
  const st = store.get();
  const prov = st.providers.find(p => p.id === id);
  if (!prov) throw new HttpError(404, '供应商不存在');
  const users = claude.scan().filter(l => l.parsed.managed && l.parsed.provider === id).map(l => l.cmd);
  const cfg = codex.readConfig();
  const refs = codex.profileRefs(cfg, id);
  if (users.length || refs.length) throw new HttpError(409, `仍被使用：${[...users.map(c => `启动器 ${c}`), ...refs].join('、')}`);
  st.providers = st.providers.filter(p => p.id !== id);
  store.save();
  const kp = store.keyPath(id);
  if (fs.existsSync(kp)) { U.backup(kp); fs.unlinkSync(kp); }
  if (cfg.model_providers?.[id]) { delete cfg.model_providers[id]; await codex.writeConfig(cfg); }
  return { ok: true };
}

async function fetchModels(id) {
  const prov = store.get().providers.find(p => p.id === id);
  if (!prov) throw new HttpError(404, '供应商不存在');
  const key = store.readKey(id);
  const tries = [];
  if (prov.openai_url) tries.push({ url: prov.openai_url + '/models', headers: { Authorization: `Bearer ${key}` } });
  if (prov.anthropic_url) {
    const base = /\/v1$/.test(prov.anthropic_url) ? prov.anthropic_url : prov.anthropic_url + '/v1';
    tries.push({ url: base + '/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', Authorization: `Bearer ${key}` } });
  }
  const errors = [];
  for (const t of tries) {
    try {
      const r = await fetch(t.url, { headers: t.headers, signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      if (!r.ok) { errors.push(`${t.url} → HTTP ${r.status} ${text.slice(0, 160)}`); continue; }
      const j = JSON.parse(text);
      const arr = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
      const ids = [...new Set(arr.map(m => m.id || m.name).filter(x => typeof x === 'string' && U.RE.model.test(x)))].sort();
      if (ids.length) return { url: t.url, models: ids };
      errors.push(`${t.url} → 返回里没有模型列表`);
    } catch (e) { errors.push(`${t.url} → ${e.message}`); }
  }
  throw new HttpError(502, errors.join('；') || '没有可用接口地址');
}

function saveLauncher(body) {
  const st = store.get();
  const n = claude.normalize(body, st.providers);
  const prov = st.providers.find(p => p.id === n.provider);
  if (!store.readKey(prov.id)) throw new HttpError(400, `供应商「${prov.name}」还没有 Key`);
  const file = path.join(U.PATHS.bin, n.cmd);
  const exists = fs.existsSync(file);
  const orig = body.orig_cmd ? String(body.orig_cmd) : '';
  if (exists && orig !== n.cmd) throw new HttpError(409, `${n.cmd} 已存在，请换个命令名`);
  if (exists) {
    const text = U.readText(file, '');
    if (!claude.parseLauncher(text)) throw new HttpError(409, `${n.cmd} 不是 Claude 启动器，拒绝覆盖`);
    if (!text.includes(claude.MARKER) && !body.confirm_takeover) throw new HttpError(428, `${n.cmd} 是手写脚本，保存会改成面板托管格式（原文件会备份）。确认继续？`);
  } else {
    const which = whichCmd(n.cmd);
    if (which && !which.startsWith(U.PATHS.bin + '/')) throw new HttpError(409, `命令名 ${n.cmd} 与系统已有命令 ${which} 冲突`);
  }
  const text = claude.render(n, prov);
  const backupName = writeLauncher(n.cmd, text);
  // 改名：删掉旧文件（备份）
  let renamed = null;
  if (orig && orig !== n.cmd) {
    const of = path.join(U.PATHS.bin, orig);
    const ot = U.readText(of, '');
    if (ot.includes(claude.MARKER) && claude.parseLauncher(ot)) { U.backup(of); fs.unlinkSync(of); renamed = orig; }
  }
  store.addModels(prov, claude.MODEL_FIELDS.map(f => n[f]));
  store.save();
  return { cmd: n.cmd, backup: backupName, renamed };
}

function whichCmd(cmd) {
  for (const d of (process.env.PATH || '').split(':')) {
    const f = path.join(d, cmd);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* 下一个 */ }
  }
  return null;
}

function deleteLauncher(cmd) {
  if (!U.RE.cmd.test(cmd)) throw new HttpError(400, '命令名不合法');
  const file = path.join(U.PATHS.bin, cmd);
  const text = U.readText(file);
  if (text == null) throw new HttpError(404, '不存在');
  const isClaude = claude.parseLauncher(text) || claude.parseAlias(text);
  const isCodex = codex.parseCodexLauncher(text);
  if (!isClaude && !isCodex) throw new HttpError(409, '不是面板可管理的启动器');
  const bk = U.backup(file);
  fs.unlinkSync(file);
  return { backup: bk };
}

function saveAlias(body) {
  const name = String(body.name || '').trim();
  const target = String(body.target || '').trim();
  if (!U.RE.cmd.test(name)) throw new HttpError(400, '别名不合法');
  if (target && !U.RE.cmd.test(target)) throw new HttpError(400, '目标不合法');
  const st = store.get();
  const file = path.join(U.PATHS.bin, name);
  const cur = U.readText(file);
  if (cur != null && !claude.parseAlias(cur)) throw new HttpError(409, `${name} 已被其他文件占用`);
  if (cur == null) {
    const w = whichCmd(name);
    if (w) throw new HttpError(409, `命令名 ${name} 与 ${w} 冲突`);
  }
  if (!target) {
    if (cur != null) { U.backup(file); fs.unlinkSync(file); }
  } else {
    const t = U.readText(path.join(U.PATHS.bin, target));
    if (!t || !claude.parseLauncher(t)) throw new HttpError(400, `${target} 不是 Claude 启动器`);
    writeLauncher(name, claude.renderAlias(target));
  }
  // 换别名名字时清理旧别名
  if (st.alias.name !== name) {
    const of = path.join(U.PATHS.bin, st.alias.name);
    if (claude.parseAlias(U.readText(of))) { U.backup(of); fs.unlinkSync(of); }
  }
  st.alias = { name, target };
  store.save();
  return { ok: true };
}

const TEST_PROMPT = 'Reply with exactly: PONG';
const running = new Set();

async function testClaude(body) {
  const cmd = String(body.cmd || '');
  if (!U.RE.cmd.test(cmd)) throw new HttpError(400, '命令名不合法');
  const file = path.join(U.PATHS.bin, cmd);
  if (!claude.parseLauncher(U.readText(file, ''))) throw new HttpError(404, '启动器不存在');
  const model = body.model ? U.checkModel(String(body.model), '模型') : '';
  const lock = 'claude:' + cmd + ':' + model;
  if (running.has(lock)) throw new HttpError(409, '该测试正在进行');
  running.add(lock);
  try {
    const args = [file, '-p', TEST_PROMPT, '--output-format', 'json', '--no-session-persistence', '--settings', '{"disableAllHooks":true}'];
    if (model) args.push('--model', model);
    const r = await U.run('bash', args, { timeout: 120000, cwd: U.HOME });
    let j = null;
    try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* 非 JSON */ }
    if (j) {
      return {
        ok: !j.is_error && j.subtype === 'success', ms: r.ms, reply: String(j.result || '').slice(0, 400),
        models: Object.keys(j.modelUsage || {}), error: j.is_error ? String(j.result || j.api_error_status || '').slice(0, 600) : '',
      };
    }
    return { ok: false, ms: r.ms, reply: '', models: [], error: r.killed ? '超时（120 秒）' : (r.stderr || r.stdout).trim().slice(-800) || `退出码 ${r.code}` };
  } finally { running.delete(lock); }
}

async function testCodex(body) {
  const name = String(body.name || '');
  if (!codex.PROFILE_RE.test(name) || !fs.existsSync(codex.profileFile(name))) throw new HttpError(404, 'profile 不存在');
  const lock = 'codex:' + name;
  if (running.has(lock)) throw new HttpError(409, '该测试正在进行');
  running.add(lock);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-panel-test-'));
  try {
    const out = path.join(dir, 'last.txt');
    const r = await U.run('codex', ['-p', name, 'exec', '--skip-git-repo-check', '--ephemeral', '-c', 'notify=[]', '-o', out, TEST_PROMPT], { timeout: 150000, cwd: dir });
    const reply = U.readText(out, '').trim();
    const log = (r.stdout + '\n' + r.stderr);
    const model = (log.match(/^model: (.+)$/m) || [])[1] || '';
    const provider = (log.match(/^provider: (.+)$/m) || [])[1] || '';
    const ok = r.code === 0 && !!reply;
    const errLines = log.split('\n').filter(l => /error|ERROR|failed|unexpected status|401|403|404|429|5\d\d/.test(l)).slice(-4).join('\n');
    return {
      ok, ms: r.ms, reply: reply.slice(0, 400), models: model ? [model] : [], provider,
      error: ok ? '' : (r.killed ? '超时（150 秒）' : (errLines || log.trim().slice(-800) || `退出码 ${r.code}`)),
    };
  } finally {
    running.delete(lock);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function saveCodexProfile(body) {
  const cfg = codex.readConfig();
  const n = codex.normalizeProfile(body, cfg);
  const orig = body.orig_name ? String(body.orig_name) : '';
  const file = codex.profileFile(n.name);
  if (fs.existsSync(file) && orig !== n.name) throw new HttpError(409, `profile ${n.name} 已存在`);
  const existing = orig && fs.existsSync(codex.profileFile(orig)) ? (codex.listProfiles().find(p => p.name === orig)?.data || {}) : {};
  let catalogFile = '';
  if (n.mode === 'generate') {
    // 目录条目的显示名/上下文取自面板供应商的模型信息
    const prov = store.get().providers.find(p => p.id === n.provider);
    const meta = id => prov?.models.find(m => m.id === id) || { id };
    catalogFile = codex.writeCatalog(n.name, n.catModels.map(id => ({ ...meta(id), context: meta(id).context || n.context })));
  } else if (n.mode === 'path') catalogFile = n.catPath;
  const data = codex.buildProfileData(existing, n, catalogFile);
  const backupName = await codex.writeProfile(n.name, data);
  let renamed = null;
  if (orig && orig !== n.name) {
    U.backup(codex.profileFile(orig)); fs.unlinkSync(codex.profileFile(orig)); renamed = orig;
  }
  let launcher = null;
  if (n.cmd) {
    const lf = path.join(U.PATHS.bin, n.cmd);
    const cur = U.readText(lf);
    if (cur != null && !codex.parseCodexLauncher(cur)) throw new HttpError(409, `profile 已保存，但命令名 ${n.cmd} 已被其他脚本占用，未创建启动命令`);
    if (cur == null) { const w = whichCmd(n.cmd); if (w) throw new HttpError(409, `profile 已保存，但命令名 ${n.cmd} 与 ${w} 冲突`); }
    writeLauncher(n.cmd, codex.renderCodexLauncher(n.name));
    launcher = n.cmd;
  }
  // 如果它就是当前默认，同步刷新 config.toml 顶层
  let defaultUpdated = false;
  if (body.was_default || body.set_default) { await setCodexDefault(n.name); defaultUpdated = true; }
  const prov = store.get().providers.find(p => p.id === n.provider);
  if (prov) { store.addModels(prov, [n.model, ...n.catModels]); store.save(); }
  return { name: n.name, backup: backupName, renamed, launcher, default_updated: defaultUpdated };
}

async function setCodexDefault(name) {
  const p = codex.listProfiles().find(x => x.name === name);
  if (!p || !p.data) throw new HttpError(404, 'profile 不存在或解析失败');
  const cfg = codex.readConfig();
  for (const k of codex.SWITCH_KEYS) {
    if (p.data[k] !== undefined) cfg[k] = p.data[k];
    else if (k !== 'model_reasoning_effort') delete cfg[k];
  }
  await codex.writeConfig(cfg);
  return { ok: true };
}

async function deleteCodexProfile(name) {
  if (!codex.PROFILE_RE.test(name)) throw new HttpError(400, 'profile 名不合法');
  const file = codex.profileFile(name);
  if (!fs.existsSync(file)) throw new HttpError(404, '不存在');
  const bk = U.backup(file);
  fs.unlinkSync(file);
  const removed = [];
  for (const f of fs.readdirSync(U.PATHS.bin)) {
    const lf = path.join(U.PATHS.bin, f);
    if (U.RE.cmd.test(f) && codex.parseCodexLauncher(U.readText(lf)) === name) { U.backup(lf); fs.unlinkSync(lf); removed.push(f); }
  }
  return { backup: bk, removed_launchers: removed };
}

function maskSecrets(text) {
  return String(text).replace(/(sk-[A-Za-z0-9_-]{2})[A-Za-z0-9_-]{8,}([A-Za-z0-9]{4})/g, '$1••••$2');
}

// ---------------------------------------------------------------- router
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, open: !!opts.open });
}

route('POST', '/api/login', async (req, res, body) => {
  const r = auth.login(clientIp(req), body.password);
  if (!r.ok) throw new HttpError(r.status, r.error);
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${auth.SESSION_TTL / 1000}${secure}`);
  return { ok: true };
}, { open: true });

route('POST', '/api/logout', async (req, res) => {
  auth.logout(cookies(req)[COOKIE]);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  return { ok: true };
}, { open: true });

route('GET', '/api/me', async req => ({ authed: auth.verify(cookies(req)[COOKIE]) }), { open: true });

route('POST', '/api/password', async (req, res, body) => {
  if (!auth.checkPassword(body.old)) throw new HttpError(400, '原密码错误');
  const pw = String(body.new || '');
  if (pw.length < 8) throw new HttpError(400, '新密码至少 8 位');
  auth.setPassword(pw);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  return { ok: true };
});

route('GET', '/api/state', async () => fullState());

route('POST', '/api/providers', async (req, res, body) => saveProvider(body));
route('DELETE', '/api/providers/:id', async (req, res, body, p) => deleteProvider(p.id));
route('POST', '/api/providers/:id/fetch-models', async (req, res, body, p) => fetchModels(p.id));

route('POST', '/api/claude/launchers', async (req, res, body) => saveLauncher(body));
route('DELETE', '/api/launchers/:cmd', async (req, res, body, p) => deleteLauncher(p.cmd));
route('GET', '/api/launchers/:cmd/source', async (req, res, body, p) => {
  if (!U.RE.cmd.test(p.cmd)) throw new HttpError(400, '命令名不合法');
  const t = U.readText(path.join(U.PATHS.bin, p.cmd));
  if (t == null) throw new HttpError(404, '不存在');
  return { text: maskSecrets(t) };
});
route('POST', '/api/claude/alias', async (req, res, body) => saveAlias(body));
route('POST', '/api/claude/test', async (req, res, body) => testClaude(body));
route('POST', '/api/claude/settings', async (req, res, body) => {
  const cs = readClaudeSettings();
  if (!cs.data) throw new HttpError(409, 'settings.json 当前不是合法 JSON，请用原始编辑修复');
  writeClaudeSettings(applyClaudeSettings(cs.data, body));
  return { ok: true };
});
route('GET', '/api/claude/settings/raw', async () => ({ text: readClaudeSettings().raw, path: '~/.claude/settings.json' }));
route('POST', '/api/claude/settings/raw', async (req, res, body) => {
  let d;
  try { d = JSON.parse(String(body.text || '')); } catch (e) { throw new HttpError(400, 'JSON 语法错误：' + e.message); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new HttpError(400, '顶层必须是对象');
  writeClaudeSettings(d);
  return { ok: true };
});

route('GET', '/api/claude/statusline/raw', async () => ({
  text: U.readText(U.PATHS.statuslineScript, ''),
  path: '~/.claude/statusline.py'
}));
route('POST', '/api/claude/statusline/raw', async (req, res, body) => {
  const text = String(body.text || '');
  if (!text.trim()) throw new HttpError(400, '脚本内容不能为空');
  U.backup(U.PATHS.statuslineScript);
  U.atomicWrite(U.PATHS.statuslineScript, text, 0o755);
  return { ok: true };
});
route('POST', '/api/claude/statusline/test', async () => {
  const mockInput = JSON.stringify({
    context_window: { total_input_tokens: 52000, context_window_size: 262144 },
    workspace: { current_dir: '/home/ubuntu/cli-panel' }
  });
  const res = await U.run('python3', [U.PATHS.statuslineScript], { input: mockInput, timeout: 3000 });
  return { ok: res.code === 0, output: (res.stdout || '').trim() || (res.stderr || '').trim(), code: res.code };
});

route('POST', '/api/codex/profiles', async (req, res, body) => saveCodexProfile(body));
route('DELETE', '/api/codex/profiles/:name', async (req, res, body, p) => deleteCodexProfile(p.name));
route('POST', '/api/codex/default', async (req, res, body) => setCodexDefault(String(body.name || '')));
route('POST', '/api/codex/test', async (req, res, body) => testCodex(body));
route('POST', '/api/codex/globals', async (req, res, body) => {
  const cfg = codex.applyGlobals(codex.readConfig(), body);
  await codex.writeConfig(cfg);
  return { ok: true };
});
route('GET', '/api/codex/catalogs', async () => ({
  catalogs: codex.listCatalogs(),
  current: codex.readConfig().model_catalog_json || '',
}));
route('POST', '/api/codex/catalogs', async (req, res, body) => {
  const target = String(body.target || body.name || '').trim();
  if (!target) throw new HttpError(400, '缺少目录名称或路径');
  const models = Array.isArray(body.models) ? body.models : [];
  if (!models.length) throw new HttpError(400, '候选模型列表不能为空');
  const result = codex.saveCatalog(target, models);
  if (body.set_default) {
    const cfg = codex.readConfig();
    cfg.model_catalog_json = result.path;
    await codex.writeConfig(cfg);
  }
  return { ok: true, catalog: result };
});
route('POST', '/api/codex/catalog/default', async (req, res, body) => {
  const pathVal = String(body.path || '').trim();
  const cfg = codex.readConfig();
  if (pathVal) cfg.model_catalog_json = pathVal;
  else delete cfg.model_catalog_json;
  await codex.writeConfig(cfg);
  return { ok: true, current: cfg.model_catalog_json || '' };
});
route('GET', '/api/codex/raw', async (req, res, body, p, q) => {
  const name = q.get('profile');
  if (name) {
    if (!codex.PROFILE_RE.test(name)) throw new HttpError(400, 'profile 名不合法');
    return { text: maskSecrets(U.readText(codex.profileFile(name), '')), path: `~/.codex/${name}.config.toml` };
  }
  const TOML = require('smol-toml');
  return { text: TOML.stringify(codex.maskConfig(codex.readConfig())) + '\n', path: '~/.codex/config.toml', masked: true };
});
route('POST', '/api/codex/raw', async (req, res, body) => {
  const TOML = require('smol-toml');
  const name = body.profile ? String(body.profile) : '';
  let parsed;
  try { parsed = TOML.parse(String(body.text || '')); } catch (e) { throw new HttpError(400, 'TOML 语法错误：' + e.message); }
  if (name) {
    if (/••••/.test(body.text)) throw new HttpError(400, 'profile 里含打码值，请填写真实值');
    await codex.writeProfile(name, parsed);
  } else {
    await codex.writeConfig(codex.unmaskConfig(parsed, codex.readConfig()));
  }
  return { ok: true };
});

// ---------------------------------------------------------------- ping / health check
route('POST', '/api/ping', async (req, res, body) => {
  let { baseUrl, apiKey, type, model, provider_id } = body;
  if (provider_id) {
    const prov = store.get().providers.find(p => p.id === provider_id);
    if (prov) {
      if (!type) type = prov.anthropic_url ? 'anthropic' : 'openai';
      if (!baseUrl) baseUrl = type === 'anthropic' ? prov.anthropic_url : prov.openai_url;
      if (!apiKey) apiKey = store.readKey(provider_id);
      if (!model && prov.models && prov.models.length > 0) model = prov.models[0].id;
    }
  }
  return await ping.pingEndpoint({ type, baseUrl, apiKey, model });
});

// ---------------------------------------------------------------- sessions & processes
route('GET', '/api/system/sessions', async () => sessions.listSessions());
route('POST', '/api/system/sessions/kill-tmux', async (req, res, body) => sessions.killTmux(body.name));
route('POST', '/api/system/sessions/kill-process', async (req, res, body) => sessions.killCliProcess(body.pid));

// ---------------------------------------------------------------- skills manager
route('GET', '/api/skills', async () => ({ skills: skills.listSkills() }));
route('GET', '/api/skills/:id', async (req, res, body, p) => {
  const sk = skills.getSkill(p.id);
  if (!sk) throw new HttpError(404, 'Skill 不存在');
  return { skill: sk };
});
route('POST', '/api/skills', async (req, res, body) => skills.saveSkill(body));
route('DELETE', '/api/skills/:target/:id', async (req, res, body, p) => skills.deleteSkill(p.id, p.target));

// ---------------------------------------------------------------- mcp manager
route('GET', '/api/mcp', async () => ({ servers: mcp.listMcpServers() }));
route('POST', '/api/mcp', async (req, res, body) => mcp.saveMcpServer(body));
route('DELETE', '/api/mcp/:id', async (req, res, body, p) => mcp.deleteMcpServer(p.id));

// ---------------------------------------------------------------- git inspector
route('GET', '/api/git/repos', async () => ({ repos: await git.listRepos() }));
route('GET', '/api/git/diff', async req => {
  const u = new URL(req.url, 'http://localhost');
  const repo = u.searchParams.get('repo');
  return await git.getRepoDiff(repo);
});
route('POST', '/api/git/action', async (req, res, body) => git.repoAction(body.repo, body.action, body));

// ---------------------------------------------------------------- usage & sessions
route('GET', '/api/usage/summary', async (req, res, body, p, query) => usage.getUsageSummary(query?.get('force') === '1'));
route('GET', '/api/usage/session/:id', async (req, res, body, p) => usage.getSessionDetail(p.id));
route('DELETE', '/api/usage/session/:id', async (req, res, body, p) => usage.deleteSession({ id: p.id }));
route('POST', '/api/usage/session/delete', async (req, res, body) => usage.deleteSession(body));
route('POST', '/api/usage/session/delete-batch', async (req, res, body) => usage.deleteSessionsBatch(body));
route('POST', '/api/usage/session/clean-empty', async () => usage.cleanEmptySessions());

// ---------------------------------------------------------------- memory & rules
route('GET', '/api/memory', async () => ({
  memories: memory.listMemories(),
  rules: memory.listRules(),
}));
route('POST', '/api/memory/item', async (req, res, body) => memory.saveMemory(body));
route('DELETE', '/api/memory/item/:slug', async (req, res, body, p) => memory.deleteMemory(p.slug));
route('GET', '/api/memory/rule/:id', async (req, res, body, p) => memory.getRule(p.id));
route('POST', '/api/memory/rule', async (req, res, body) => memory.saveRule(body.id, body.content));

// ---------------------------------------------------------------- doctor & diagnostics
route('GET', '/api/doctor', async () => ({ diagnostics: await doctor.runDiagnostics() }));
route('POST', '/api/doctor/fix', async (req, res, body) => doctor.runFix(body.id));

// ---------------------------------------------------------------- hardware hud & system
route('GET', '/api/system/hud', async () => system.getSystemHud());

// ---------------------------------------------------------------- tmux live capture & dispatch
route('GET', '/api/tmux/pane', async (req, res, body, p, query) => {
  const sess = query?.get('target') || query?.get('session');
  const lines = query?.get('lines');
  return sessions.captureTmuxPane(sess, lines);
});
route('POST', '/api/tmux/send', async (req, res, body) => {
  return sessions.sendTmuxKeys(body.target || body.session, body.text, body.enter !== false);
});
route('POST', '/api/tmux/signal', async (req, res, body) => {
  return sessions.sendTmuxSignal(body.target || body.session, body.signal);
});
route('POST', '/api/tmux/window/kill', async (req, res, body) => {
  return sessions.killTmuxWindow(body.target);
});
route('POST', '/api/tmux/window/create', async (req, res, body) => {
  return sessions.createTmuxWindow(body.session, body.name, body.path);
});
route('POST', '/api/tmux/window/select', async (req, res, body) => {
  return sessions.selectTmuxWindow(body.target);
});
route('POST', '/api/tmux/clean-idle', async () => {
  return sessions.cleanIdleTmuxWindows();
});

route('GET', '/api/backups', async () => ({ items: U.listBackups().slice(0, 200) }));
route('GET', '/api/backups/:name', async (req, res, body, p) => {
  const b = U.readBackup(p.name);
  const cur = U.readText(b.target);
  return { text: maskSecrets(b.content.toString('utf8')), current: cur == null ? null : maskSecrets(cur), target: b.target.replace(U.HOME, '~') };
});
route('POST', '/api/backups/:name/restore', async (req, res, body, p) => {
  const b = U.readBackup(p.name);
  if (!U.isWritable(b.target)) throw new HttpError(403, '该路径不允许恢复');
  if (b.target === U.PATHS.codexConfig) await codex.validate(b.content.toString('utf8'));
  U.backup(b.target);
  const mode = b.target.startsWith(U.PATHS.bin + '/') ? 0o755 : b.target === U.PATHS.claudeSettings ? 0o644 : 0o600;
  U.atomicWrite(b.target, b.content, mode);
  return { ok: true, target: b.target.replace(U.HOME, '~') };
});

route('GET', '/api/logs/prompts', async (req, res, body, p, query) => {
  return logs.getPrompts({
    limit: query.get('limit') || 80,
    search: query.get('search') || '',
    client: query.get('client') || ''
  });
});
route('GET', '/api/logs/errors', async (req, res, body, p, query) => {
  return logs.getErrors({
    limit: query.get('limit') || 50,
    search: query.get('search') || ''
  });
});
route('GET', '/api/logs/daemon', async (req, res, body, p, query) => {
  return logs.getDaemonLogs({
    lines: query.get('lines') || 120,
    source: query.get('source') || 'pm2'
  });
});

route('GET', '/api/cleaner/scan', async () => {
  return cleaner.scanJunk();
});

route('GET', '/api/cleaner/large-files', async (req, res, body, p, query) => {
  return cleaner.getLargeFiles({
    limit: query.get('limit') || 30,
    minMb: query.get('minMb') || 30
  });
});

route('GET', '/api/cleaner/large-dirs', async (req, res, body, p, query) => {
  return cleaner.getLargeDirs({
    limit: query.get('limit') || 15
  });
});

route('POST', '/api/cleaner/clean', async (req, res, body) => {
  return cleaner.cleanJunk(body.category_ids);
});

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const data = fs.readFileSync(path.join(PUBLIC, file));
      return send(res, 200, data, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not Found');
    const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, '接口不存在');
    // CSRF：写操作必须带自定义头（跨站表单/图片无法伪造）
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'cli-panel') throw new HttpError(403, '缺少请求头');
    if (!r.open && !auth.verify(cookies(req)[COOKIE])) throw new HttpError(401, '未登录或会话已过期');
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = await r.handler(req, res, body, params, url.searchParams);
    send(res, 200, out);
  } catch (e) {
    const status = e.status || (e instanceof SyntaxError ? 400 : e.message && !e.code ? 400 : 500);
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message || '服务器错误' });
  }
});

store.load();
auth.loadAuth();
server.listen(PORT, HOST, () => console.log(`[cli-panel] http://${HOST}:${PORT}`));
