'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = os.homedir();
const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLI_PANEL_DATA || path.join(ROOT, 'data');
const BACKUP_DIR = path.join(DATA, 'backups');
const PATHS = {
  bin: path.join(HOME, '.local', 'bin'),
  claudeSettings: path.join(HOME, '.claude', 'settings.json'),
  statuslineScript: path.join(HOME, '.claude', 'statusline.py'),
  codexHome: path.join(HOME, '.codex'),
  codexConfig: path.join(HOME, '.codex', 'config.toml'),
  catalogDir: path.join(HOME, '.codex', 'panel-catalogs'),
  keyDir: path.join(HOME, '.config', 'cli-panel', 'keys'),
  oldConfigDir: path.join(HOME, '.config'),
};

// 允许面板写入/恢复的路径前缀（备份恢复时校验）
const WRITABLE_ROOTS = [PATHS.bin + '/', PATHS.codexHome + '/', PATHS.claudeSettings, PATHS.statuslineScript, PATHS.keyDir + '/'];

function isWritable(p) {
  const abs = path.resolve(p);
  return WRITABLE_ROOTS.some(r => (r.endsWith('/') ? abs.startsWith(r) : abs === r));
}

function atomicWrite(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.panel-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function encodePath(p) { return p.replace(HOME, '~').replace(/%/g, '%25').replace(/\//g, '%2F'); }
function decodePath(s) { return s.replace(/%2F/g, '/').replace(/%25/g, '%').replace(/^~/, HOME); }

// 写入前备份原文件；返回备份名
function backup(file) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const name = `${stamp()}__${encodePath(file)}`;
  fs.copyFileSync(file, path.join(BACKUP_DIR, name));
  fs.chmodSync(path.join(BACKUP_DIR, name), 0o600);
  pruneBackups();
  return name;
}

function pruneBackups(keep = 300) {
  const all = fs.readdirSync(BACKUP_DIR).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).sort().reverse().map(name => {
    const i = name.indexOf('__');
    const st = fs.statSync(path.join(BACKUP_DIR, name));
    return { name, time: name.slice(0, i), path: decodePath(name.slice(i + 2)).replace(HOME, '~'), size: st.size };
  });
}

function readBackup(name) {
  if (!/^[\w-]+__[\w.%~-]+$/.test(name)) throw new Error('非法备份名');
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw new Error('备份不存在');
  const target = decodePath(name.slice(name.indexOf('__') + 2));
  return { content: fs.readFileSync(file), target };
}

function readText(file, fallback = null) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// bash 单引号转义：任何内容都安全
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function run(cmd, args, { timeout = 120000, cwd, env, input } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = execFile(cmd, args, { timeout, cwd, env, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        killed: !!(err && err.killed),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        ms: Date.now() - t0,
      });
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

const RE = {
  id: /^[a-z][a-z0-9_-]{0,31}$/,
  cmd: /^[a-z][a-z0-9-]{1,39}$/,
  model: /^[A-Za-z0-9][A-Za-z0-9._:\/@+\[\]-]{0,127}$/,
  envKey: /^[A-Z_][A-Z0-9_]{0,63}$/,
};

function checkUrl(u, label) {
  if (!u) return '';
  let x;
  try { x = new URL(u); } catch { throw new Error(`${label} 不是合法 URL`); }
  if (!/^https?:$/.test(x.protocol)) throw new Error(`${label} 只支持 http/https`);
  if (/[\s'"`$\\]/.test(u)) throw new Error(`${label} 含非法字符`);
  return u.replace(/\/+$/, '');
}

function checkModel(m, label, optional = true) {
  if (!m) { if (optional) return ''; throw new Error(`${label} 必填`); }
  if (!RE.model.test(m)) throw new Error(`${label} 「${m}」含非法字符`);
  return m;
}

function intOrNull(v, label, min = 1, max = 1e8) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} 需为 ${min}~${max} 的整数`);
  return n;
}

function cleanText(s, max = 200) {
  return String(s || '').replace(/[\r\n\t]/g, ' ').slice(0, max).trim();
}

function mask(key) {
  if (!key) return '';
  return '••••' + key.slice(-4);
}

module.exports = {
  HOME, ROOT, DATA, PATHS, BACKUP_DIR, isWritable, atomicWrite, backup, listBackups, readBackup,
  readText, sha, shq, run, RE, checkUrl, checkModel, intOrNull, cleanText, mask, stamp,
};
