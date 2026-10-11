'use strict';
// Claude Code 启动器：解析 ~/.local/bin 下的 wrapper 脚本 / 由结构化配置生成脚本
const fs = require('fs');
const path = require('path');
const { PATHS, HOME, shq, RE, checkModel, intOrNull, cleanText, readText } = require('./util');

const MARKER = '# managed-by: cli-panel';
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

// 表单字段 ↔ 环境变量
const FIELD_ENV = {
  model: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  opus_name: 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  opus_desc: 'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  sonnet_name: 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  sonnet_desc: 'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  haiku_name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  haiku_desc: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  custom: 'ANTHROPIC_CUSTOM_MODEL_OPTION',
  custom_name: 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  custom_desc: 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
  small_fast: 'ANTHROPIC_SMALL_FAST_MODEL',
};
const MODEL_FIELDS = ['model', 'opus', 'sonnet', 'haiku', 'custom', 'subagent', 'small_fast'];
// 这些变量由面板专门处理，不进入「额外环境变量」
const RESERVED = new Set([
  ...Object.values(FIELD_ENV), 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_STATUS_CONTEXT_WINDOW',
  'CLAUDE_CODE_EFFORT_LEVEL',
]);
// Claude Code 二进制里不存在的变量（实测），导入时丢弃并提示
const INVALID_ENV = new Set(['ANTHROPIC_EXTRA_MODELS']);

function unquote(v) {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/'\\''/g, "'");
  const m = v.match(/^\$\{[A-Z_][A-Z0-9_]*:-([^}]*)\}$/);
  if (m) return m[1];
  return v;
}

function keyFileOf(text) {
  let m = text.match(/key_file="\$HOME\/\.config\/cli-panel\/keys\/([\w-]+)\.key"/);
  if (m) return path.join(PATHS.keyDir, m[1] + '.key');
  m = text.match(/config_dir="\$\{XDG_CONFIG_HOME:-\$HOME\/\.config\}\/([\w-]+)"/);
  if (m) return path.join(HOME, '.config', m[1], 'api_key');
  return null;
}

// 解析任意 claude wrapper：exec env ... claude [flags] "$@"
function parseLauncher(text) {
  const execAt = text.search(/^\s*exec env\b/m);
  if (execAt < 0 || !/\bclaude\b/.test(text.slice(execAt))) return null;
  const block = text.slice(execAt);
  const env = {};
  const re = /^\s*([A-Z_][A-Z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^']|'\\'')*'|[^\s\\]+)\s*\\?\s*$/gm;
  let m;
  while ((m = re.exec(block))) env[m[1]] = unquote(m[2]);
  if (!env.ANTHROPIC_BASE_URL) return null;
  const tail = block.slice(block.search(/^\s*claude\b/m));
  let effort = '';
  const em = tail.match(/--effort\s+("[^"]*"|'[^']*'|\S+)/);
  if (em) effort = unquote(em[1]);
  else if (env.CLAUDE_CODE_EFFORT_LEVEL) effort = env.CLAUDE_CODE_EFFORT_LEVEL;
  const p = {
    base_url: env.ANTHROPIC_BASE_URL,
    key_file: keyFileOf(text),
    effort: EFFORTS.includes(effort) ? effort : '',
    append_sp: /--append-system-prompt/.test(tail),
    compact: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '',
    context: env.CLAUDE_CODE_MAX_CONTEXT_TOKENS || env.CLAUDE_STATUS_CONTEXT_WINDOW || '',
    extra_env: [],
    dropped: [],
    managed: text.includes(MARKER),
  };
  for (const [f, k] of Object.entries(FIELD_ENV)) p[f] = env[k] || '';
  for (const [k, v] of Object.entries(env)) {
    if (INVALID_ENV.has(k)) p.dropped.push(k);
    else if (!RESERVED.has(k)) p.extra_env.push({ k, v });
  }
  if (env.CLAUDE_CODE_EFFORT_LEVEL) p.dropped.push('CLAUDE_CODE_EFFORT_LEVEL（已转成 --effort）');
  const pm = text.match(/^# provider: ([\w-]+)$/m);
  if (pm) p.provider = pm[1];
  const nm = text.match(/^# note: (.*)$/m);
  p.note = nm ? nm[1] : '';
  return p;
}

function normalize(input, providers) {
  const p = {};
  p.cmd = String(input.cmd || '').trim();
  if (!RE.cmd.test(p.cmd)) throw new Error('命令名只能用小写字母、数字、-，2~40 位，字母开头');
  p.provider = String(input.provider || '');
  const prov = providers.find(x => x.id === p.provider);
  if (!prov) throw new Error('请选择供应商');
  if (!prov.anthropic_url) throw new Error(`供应商「${prov.name}」没有填 Anthropic 接口地址，Claude Code 无法使用`);
  for (const f of MODEL_FIELDS) p[f] = checkModel(String(input[f] || '').trim(), f);
  if (!p.model) throw new Error('主模型必填');
  for (const f of ['opus', 'sonnet', 'haiku', 'custom']) {
    p[f + '_name'] = cleanText(input[f + '_name'], 80);
    p[f + '_desc'] = cleanText(input[f + '_desc'], 200);
  }
  p.context = intOrNull(input.context, '上下文窗口', 1000, 1e7);
  p.compact = intOrNull(input.compact, '自动压缩窗口', 1000, 1e7);
  p.effort = EFFORTS.includes(input.effort) ? input.effort : '';
  p.append_sp = !!input.append_sp;
  p.note = cleanText(input.note, 120);
  p.extra_env = [];
  for (const e of input.extra_env || []) {
    const k = String(e.k || '').trim();
    if (!k) continue;
    if (!RE.envKey.test(k)) throw new Error(`环境变量名「${k}」不合法`);
    if (RESERVED.has(k)) throw new Error(`${k} 由表单字段管理，不要写在额外变量里`);
    if (INVALID_ENV.has(k)) throw new Error(`${k} 在 Claude Code 中不存在（无效变量）`);
    p.extra_env.push({ k, v: String(e.v ?? '').replace(/[\r\n]/g, ' ') });
  }
  return p;
}

function effortEnvName(cmd) { return cmd.toUpperCase().replace(/-/g, '_') + '_EFFORT'; }

function render(p, prov) {
  const L = [];
  const envLine = (k, v) => L.push(`  ${k}=${shq(v)} \\`);
  L.push('#!/usr/bin/env bash');
  L.push(MARKER);
  L.push(`# 由 CLI 配置面板生成，手改会在下次保存时被覆盖（覆盖前自动备份）。`);
  L.push(`# provider: ${prov.id}`);
  if (p.note) L.push(`# note: ${p.note}`);
  L.push('set -euo pipefail');
  L.push(`key_file="$HOME/.config/cli-panel/keys/${prov.id}.key"`);
  L.push('if [[ -n "${CLI_PANEL_API_KEY:-}" ]]; then');
  L.push('  api_key="$CLI_PANEL_API_KEY"');
  L.push('elif [[ -r "$key_file" ]]; then');
  L.push('  IFS= read -r api_key < "$key_file"');
  L.push('else');
  L.push(`  printf '缺少密钥文件 %s，请在 CLI 配置面板里给供应商「%s」填写 Key\\n' "$key_file" ${shq(prov.name)} >&2`);
  L.push('  exit 1');
  L.push('fi');
  L.push('exec env \\');
  L.push('  -u ANTHROPIC_API_KEY \\');
  L.push('  -u CLAUDE_CODE_USE_BEDROCK \\');
  L.push('  -u CLAUDE_CODE_USE_VERTEX \\');
  L.push('  -u CLAUDE_CODE_EFFORT_LEVEL \\');
  envLine('ANTHROPIC_BASE_URL', prov.anthropic_url);
  L.push('  ANTHROPIC_AUTH_TOKEN="$api_key" \\');
  for (const [f, k] of Object.entries(FIELD_ENV)) if (p[f]) envLine(k, p[f]);
  if (p.compact) L.push(`  CLAUDE_CODE_AUTO_COMPACT_WINDOW="\${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-${p.compact}}" \\`);
  if (p.context) {
    L.push(`  CLAUDE_CODE_MAX_CONTEXT_TOKENS="\${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-${p.context}}" \\`);
    L.push(`  CLAUDE_STATUS_CONTEXT_WINDOW="\${CLAUDE_STATUS_CONTEXT_WINDOW:-${p.context}}" \\`);
  }
  for (const e of p.extra_env) envLine(e.k, e.v);
  const flags = [];
  if (p.effort) flags.push(`--effort "\${${effortEnvName(p.cmd)}:-${p.effort}}"`);
  if (p.append_sp) flags.push(`--append-system-prompt " "`);
  L.push(`  claude ${flags.concat('"$@"').join(' ')}`);
  return L.join('\n') + '\n';
}

function renderAlias(target) {
  return ['#!/usr/bin/env bash', MARKER, `# 默认 Claude 启动器别名 → ${target}`, `exec ${shq(path.join(PATHS.bin, target))} "$@"`, ''].join('\n');
}

function parseAlias(text) {
  if (!text || !text.includes(MARKER)) return null;
  const m = text.match(/^exec '([^']+)' "\$@"$/m);
  return m ? path.basename(m[1]) : null;
}

// 扫描 bin 下所有 claude 启动器
function scan() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(PATHS.bin); } catch { return out; }
  for (const f of files) {
    if (!RE.cmd.test(f)) continue; // 跳过 .bak 等
    const full = path.join(PATHS.bin, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile() || st.size > 64 * 1024) continue;
    const text = readText(full, '');
    if (!text.startsWith('#!')) continue;
    const p = parseLauncher(text);
    if (p) out.push({ cmd: f, path: full, text, parsed: p });
  }
  return out;
}

module.exports = { MARKER, EFFORTS, FIELD_ENV, MODEL_FIELDS, parseLauncher, normalize, render, renderAlias, parseAlias, scan, effortEnvName };
