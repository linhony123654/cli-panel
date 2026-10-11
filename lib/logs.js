'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { HOME } = require('./util');
const sessions = require('./sessions');

const CLAUDE_HIST = path.join(HOME, '.claude', 'history.jsonl');
const CODEX_HIST = path.join(HOME, '.codex', 'history.jsonl');
const CLAUDE_PROJ = path.join(HOME, '.claude', 'projects');
const PM2_LOG_DIR = path.join(HOME, '.pm2', 'logs');

/**
 * 获取交互 Prompt 历史流（Claude Code + Codex CLI）
 */
function getPrompts({ limit = 80, search = '', client = '' } = {}) {
  const items = [];
  const q = String(search || '').toLowerCase();
  const cFilter = String(client || '').toLowerCase();

  // 1. Claude Code Prompts
  if ((!cFilter || cFilter === 'claude') && fs.existsSync(CLAUDE_HIST)) {
    try {
      // Read last 500 lines
      const raw = execSync(`tail -n 600 ${JSON.stringify(CLAUDE_HIST)} 2>/dev/null`, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 3000
      });
      const lines = raw.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const text = obj.display || '';
          const project = obj.project || '';
          if (q && !text.toLowerCase().includes(q) && !project.toLowerCase().includes(q)) {
            continue;
          }
          items.push({
            id: 'cc_' + (obj.timestamp || Date.now()) + '_' + Math.random().toString(36).slice(2, 6),
            client: 'Claude Code',
            ts: obj.timestamp || Date.now(),
            text,
            project,
            sessionId: obj.sessionId || '',
          });
        } catch {}
      }
    } catch {}
  }

  // 2. Codex CLI Prompts
  if ((!cFilter || cFilter === 'codex') && fs.existsSync(CODEX_HIST)) {
    try {
      const raw = execSync(`tail -n 600 ${JSON.stringify(CODEX_HIST)} 2>/dev/null`, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 3000
      });
      const lines = raw.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const text = obj.text || '';
          const sessionId = obj.session_id || '';
          if (q && !text.toLowerCase().includes(q) && !sessionId.toLowerCase().includes(q)) {
            continue;
          }
          items.push({
            id: 'codex_' + (obj.ts ? obj.ts * 1000 : Date.now()) + '_' + Math.random().toString(36).slice(2, 6),
            client: 'Codex CLI',
            ts: obj.ts ? (obj.ts < 1e11 ? obj.ts * 1000 : obj.ts) : Date.now(),
            text,
            project: '~/.codex',
            sessionId,
          });
        } catch {}
      }
    } catch {}
  }

  // Sort by timestamp desc
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, Math.min(200, Math.max(10, parseInt(limit, 10) || 80)));
}

/**
 * 扫描并聚合 CLI 错误与异常诊断（429 限流、API 500、工具失败、服务报错）
 */
function getErrors({ limit = 50, search = '' } = {}) {
  const errors = [];
  const q = String(search || '').toLowerCase();

  // 1. Scan recent Claude Project sessions
  if (fs.existsSync(CLAUDE_PROJ)) {
    try {
      const subdirs = fs.readdirSync(CLAUDE_PROJ);
      const files = [];
      for (const sub of subdirs) {
        const full = path.join(CLAUDE_PROJ, sub);
        if (!fs.statSync(full).isDirectory()) continue;
        const sFiles = fs.readdirSync(full).filter(f => f.endsWith('.jsonl'));
        for (const f of sFiles) {
          const p = path.join(full, f);
          try {
            files.push({ p, mtime: fs.statSync(p).mtimeMs, sub });
          } catch {}
        }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      const topFiles = files.slice(0, 5);

      for (const { p, sub } of topFiles) {
        try {
          const raw = execSync(`tail -n 500 ${JSON.stringify(p)} 2>/dev/null`, {
            encoding: 'utf8',
            maxBuffer: 15 * 1024 * 1024,
            timeout: 3000
          });
          const lines = raw.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            if (!line.includes('error') && !line.includes('Error') && !line.includes('429')) continue;
            try {
              const obj = JSON.parse(line);
              let errItem = null;
              if (obj.subtype === 'api_error' || obj.error?.status === 429) {
                const status = obj.error?.status || 429;
                const msg = obj.error?.formatted || obj.error?.message || 'API 请求异常';
                errItem = {
                  type: status === 429 ? '429 限流' : `API ${status} 异常`,
                  level: 'error',
                  status,
                  message: msg,
                  ts: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now(),
                  project: obj.cwd || sub.replace(/^-/, '/').replace(/-/g, '/'),
                  sessionId: obj.sessionId || path.basename(p, '.jsonl')
                };
              } else if (obj.type === 'user' && obj.toolUseResult && String(obj.toolUseResult).startsWith('Error:')) {
                errItem = {
                  type: '工具执行异常',
                  level: 'warning',
                  status: 'WARN',
                  message: String(obj.toolUseResult).slice(0, 260),
                  ts: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now(),
                  project: obj.cwd || '',
                  sessionId: obj.sessionId || path.basename(p, '.jsonl')
                };
              }

              if (errItem) {
                if (q && !errItem.message.toLowerCase().includes(q) && !errItem.project.toLowerCase().includes(q)) {
                  continue;
                }
                errors.push(errItem);
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  // 2. Scan PM2 cli-panel error logs
  const pm2Err = path.join(PM2_LOG_DIR, 'cli-panel-error.log');
  if (fs.existsSync(pm2Err)) {
    try {
      const pRaw = execSync(`tail -n 120 ${JSON.stringify(pm2Err)} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
      const pLines = pRaw.split('\n');
      for (const pl of pLines) {
        const line = pl.trim();
        if (line.includes('Error:') || line.includes('SyntaxError') || line.includes('HttpError:')) {
          if (q && !line.toLowerCase().includes(q)) continue;
          errors.push({
            type: '面板服务报错',
            level: 'error',
            status: 'ERR',
            message: line,
            ts: Date.now() - 60000,
            project: 'cli-panel',
            sessionId: 'pm2'
          });
        }
      }
    } catch {}
  }

  // De-duplicate similar errors happening within 5s
  const unique = [];
  const seen = new Set();
  for (const e of errors) {
    const key = `${e.type}|${e.message.slice(0, 60)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(e);
    }
  }

  unique.sort((a, b) => b.ts - a.ts);
  return unique.slice(0, Math.min(100, Math.max(5, parseInt(limit, 10) || 50)));
}

/**
 * 读取后台运行日志流（PM2 控制台输出或 Tmux 活跃终端输出）
 */
function getDaemonLogs({ lines = 120, source = 'pm2' } = {}) {
  const l = Math.min(500, Math.max(20, parseInt(lines, 10) || 120));

  if (source.startsWith('tmux:')) {
    const sessName = source.slice(5);
    try {
      const res = sessions.captureTmuxPane(sessName, l);
      return {
        source,
        lines: l,
        text: res.text || '（终端暂无输出）',
        updated: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      };
    } catch (err) {
      return {
        source,
        lines: l,
        text: `[读取失败] ${err.message}`,
        updated: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      };
    }
  }

  // Default: PM2 CLI Panel out & err logs
  let combined = '';
  const outLog = path.join(PM2_LOG_DIR, 'cli-panel-out.log');
  const errLog = path.join(PM2_LOG_DIR, 'cli-panel-error.log');

  try {
    if (fs.existsSync(outLog)) {
      const outText = execSync(`tail -n ${l} ${JSON.stringify(outLog)} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
      combined += `=== STDOUT (${path.basename(outLog)}) ===\n` + outText.trim() + '\n\n';
    }
    if (fs.existsSync(errLog)) {
      const errText = execSync(`tail -n ${Math.min(50, l)} ${JSON.stringify(errLog)} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
      if (errText.trim()) {
        combined += `=== STDERR (${path.basename(errLog)}) ===\n` + errText.trim() + '\n';
      }
    }
  } catch (err) {
    combined = `[读取日志失败]: ${err.message}`;
  }

  return {
    source: 'pm2',
    lines: l,
    text: combined.trim() || '（日志暂无输出）',
    updated: new Date().toLocaleTimeString('zh-CN', { hour12: false })
  };
}

module.exports = {
  getPrompts,
  getErrors,
  getDaemonLogs
};
