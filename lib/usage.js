'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { HOME } = require('./util');

const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(HOME, '.codex', 'sessions');

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0) + ' ' + units[i];
}

function parseClaudeProjectDir(dirName) {
  if (dirName === '-home-ubuntu') return 'workspace (~)';
  return dirName.replace(/^-home-ubuntu-/, '').replace(/^-/, '');
}

async function parseClaudeSessionFile(filePath, projectName) {
  const stat = fs.statSync(filePath);
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let firstPrompt = '';
  let model = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let userTurns = 0;
  let firstTime = '';
  let lastTime = '';

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.timestamp) {
        if (!firstTime) firstTime = obj.timestamp;
        lastTime = obj.timestamp;
      }

      if (obj.type === 'user') {
        userTurns++;
        if (!firstPrompt && obj.message?.content) {
          const c = obj.message.content;
          if (typeof c === 'string') {
            firstPrompt = c.trim();
          } else if (Array.isArray(c)) {
            const textPart = c.find(p => p.type === 'text');
            firstPrompt = textPart ? textPart.text.trim() : JSON.stringify(c);
          }
        }
      }

      if (obj.type === 'assistant' && obj.message) {
        if (obj.message.model && obj.message.model !== '<synthetic>') {
          model = obj.message.model;
        }
        const u = obj.message.usage;
        if (u) {
          inputTokens += u.input_tokens || 0;
          outputTokens += u.output_tokens || 0;
          cacheReadTokens += u.cache_read_input_tokens || 0;
        }
      }
    } catch {}
  }

  const id = path.basename(filePath, '.jsonl');
  return {
    id,
    type: 'claude',
    project: projectName,
    first_prompt: firstPrompt.slice(0, 160) || '(无文本提示)',
    model: model || '未知模型',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    total_tokens: inputTokens + outputTokens + cacheReadTokens,
    turns: userTurns,
    time: lastTime || firstTime || stat.mtime.toISOString(),
    mtime: stat.mtimeMs,
    file_path: filePath,
    size_bytes: stat.size,
    formatted_size: formatBytes(stat.size),
  };
}

// Find all codex rollout files
function findCodexRolloutFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        results.push(...findCodexRolloutFiles(full));
      } else if (ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

async function parseCodexSessionFile(filePath) {
  const stat = fs.statSync(filePath);
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let id = '';
  let model = '';
  let provider = '';
  let firstPrompt = '';
  let userTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let firstTime = '';
  let lastTime = '';

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.timestamp) {
        if (!firstTime) firstTime = obj.timestamp;
        lastTime = obj.timestamp;
      }
      if (obj.type === 'session_meta' && obj.payload) {
        id = obj.payload.session_id || obj.payload.id || '';
        provider = obj.payload.model_provider || '';
        model = obj.payload.base_instructions?.provenance?.model || '';
      }
      if (obj.type === 'event_msg' && obj.payload) {
        if (obj.payload.type === 'user_message' && !firstPrompt) {
          firstPrompt = String(obj.payload.message || '').trim();
          userTurns++;
        }
        if (obj.payload.token_usage) {
          inputTokens += obj.payload.token_usage.prompt_tokens || 0;
          outputTokens += obj.payload.token_usage.completion_tokens || 0;
        }
      }
    } catch {}
  }

  return {
    id: id || path.basename(filePath, '.jsonl'),
    type: 'codex',
    project: 'codex-workspace',
    first_prompt: firstPrompt.slice(0, 160) || '(Codex 会话)',
    model: model ? `${provider}/${model}` : (provider || 'Codex'),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: 0,
    total_tokens: inputTokens + outputTokens,
    turns: userTurns || 1,
    time: lastTime || firstTime || stat.mtime.toISOString(),
    mtime: stat.mtimeMs,
    file_path: filePath,
    size_bytes: stat.size,
    formatted_size: formatBytes(stat.size),
  };
}

let summaryCache = null;
let summaryCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000;

async function getUsageSummary(force = false) {
  if (!force && summaryCache && Date.now() - summaryCacheTime < CACHE_TTL_MS) {
    return summaryCache;
  }

  const allSessions = [];

  // 1. Scan Claude projects
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    try {
      const pDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
      for (const pd of pDirs) {
        const fullPd = path.join(CLAUDE_PROJECTS_DIR, pd);
        if (!fs.statSync(fullPd).isDirectory()) continue;
        const pName = parseClaudeProjectDir(pd);
        const files = fs.readdirSync(fullPd).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          try {
            const sess = await parseClaudeSessionFile(path.join(fullPd, f), pName);
            allSessions.push(sess);
          } catch {}
        }
      }
    } catch {}
  }

  // 2. Scan Codex sessions
  if (fs.existsSync(CODEX_SESSIONS_DIR)) {
    try {
      const codexFiles = findCodexRolloutFiles(CODEX_SESSIONS_DIR);
      for (const cf of codexFiles) {
        try {
          const sess = await parseCodexSessionFile(cf);
          allSessions.push(sess);
        } catch {}
      }
    } catch {}
  }

  // Sort descending by time
  allSessions.sort((a, b) => b.mtime - a.mtime);

  // Aggregations
  let totalInput = 0;
  let totalOutput = 0;
  let totalCache = 0;
  const modelStats = {};
  const projectStats = {};

  for (const s of allSessions) {
    totalInput += s.input_tokens;
    totalOutput += s.output_tokens;
    totalCache += s.cache_read_tokens;

    if (s.model && s.model !== '未知模型') {
      modelStats[s.model] = (modelStats[s.model] || 0) + (s.total_tokens || 1);
    }
    if (s.project) {
      projectStats[s.project] = (projectStats[s.project] || 0) + (s.total_tokens || 1);
    }
  }

  const topModels = Object.entries(modelStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([m, tokens]) => ({ model: m, tokens, formatted: formatNumber(tokens) }));

  const zeroTokenSessions = allSessions.filter(s => (s.total_tokens || 0) === 0);

  const result = {
    totals: {
      sessions_count: allSessions.length,
      zero_sessions_count: zeroTokenSessions.length,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cache_read_tokens: totalCache,
      grand_total_tokens: totalInput + totalOutput + totalCache,
      formatted_input: formatNumber(totalInput),
      formatted_output: formatNumber(totalOutput),
      formatted_cache: formatNumber(totalCache),
      formatted_grand: formatNumber(totalInput + totalOutput + totalCache),
      total_disk_bytes: allSessions.reduce((acc, s) => acc + (s.size_bytes || 0), 0),
      formatted_disk: formatBytes(allSessions.reduce((acc, s) => acc + (s.size_bytes || 0), 0)),
    },
    top_models: topModels,
    sessions: allSessions.slice(0, 200), // Return recent 200 sessions
  };

  summaryCache = result;
  summaryCacheTime = Date.now();
  return result;
}

async function getSessionDetail(id) {
  if (!id || typeof id !== 'string') throw new Error('无效的会话 ID');

  // Search in Claude projects
  let targetFile = null;
  let sessionType = 'claude';

  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    const pDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
    for (const pd of pDirs) {
      const candidate = path.join(CLAUDE_PROJECTS_DIR, pd, `${id}.jsonl`);
      if (fs.existsSync(candidate)) {
        targetFile = candidate;
        break;
      }
    }
  }

  // If not found, search in Codex sessions
  if (!targetFile && fs.existsSync(CODEX_SESSIONS_DIR)) {
    const codexFiles = findCodexRolloutFiles(CODEX_SESSIONS_DIR);
    const found = codexFiles.find(f => f.includes(id));
    if (found) {
      targetFile = found;
      sessionType = 'codex';
    }
  }

  if (!targetFile) throw new Error('未找到该会话的历史记录文件');

  const messages = [];
  const fileStream = fs.createReadStream(targetFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (sessionType === 'claude') {
        if (obj.type === 'user' || obj.type === 'assistant') {
          let text = '';
          const content = obj.message?.content;
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter(p => p.type === 'text')
              .map(p => p.text)
              .join('\n');
          }
          if (text) {
            messages.push({
              role: obj.type,
              text: text.slice(0, 2000), // Cap for performance
              truncated: text.length > 2000,
              timestamp: obj.timestamp || '',
              model: obj.message?.model || '',
            });
          }
        }
      } else if (sessionType === 'codex') {
        if (obj.type === 'event_msg' && obj.payload) {
          if (obj.payload.type === 'user_message') {
            messages.push({
              role: 'user',
              text: String(obj.payload.message || '').slice(0, 2000),
              timestamp: obj.timestamp || '',
            });
          } else if (obj.payload.type === 'agent_message') {
            messages.push({
              role: 'assistant',
              text: String(obj.payload.message || '').slice(0, 2000),
              timestamp: obj.timestamp || '',
            });
          }
        }
      }
    } catch {}
  }

  return {
    id,
    type: sessionType,
    messages: messages.slice(-50), // Return up to 50 most recent turns
  };
}

/**
 * 安全删除单个会话记录文件并释放磁盘空间
 */
function deleteSession({ id, file_path }) {
  if (!id && !file_path) {
    throw new Error('缺少会话 ID 或文件路径');
  }

  let targetFile = null;

  if (file_path) {
    const resolved = path.resolve(file_path);
    const inClaude = resolved.startsWith(path.resolve(CLAUDE_PROJECTS_DIR));
    const inCodex = resolved.startsWith(path.resolve(CODEX_SESSIONS_DIR));
    if ((inClaude || inCodex) && resolved.endsWith('.jsonl') && fs.existsSync(resolved)) {
      targetFile = resolved;
    }
  }

  if (!targetFile && id) {
    // 1. Search in Claude projects
    if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      const pDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
      for (const pd of pDirs) {
        const candidate = path.join(CLAUDE_PROJECTS_DIR, pd, `${id}.jsonl`);
        if (fs.existsSync(candidate)) {
          targetFile = candidate;
          break;
        }
      }
    }

    // 2. Search in Codex sessions
    if (!targetFile && fs.existsSync(CODEX_SESSIONS_DIR)) {
      const codexFiles = findCodexRolloutFiles(CODEX_SESSIONS_DIR);
      const found = codexFiles.find(f => f.includes(id) || path.basename(f, '.jsonl') === id);
      if (found) {
        targetFile = found;
      }
    }
  }

  if (!targetFile || !fs.existsSync(targetFile)) {
    throw new Error('未找到指定的会话文件');
  }

  const resolved = path.resolve(targetFile);
  const inClaude = resolved.startsWith(path.resolve(CLAUDE_PROJECTS_DIR));
  const inCodex = resolved.startsWith(path.resolve(CODEX_SESSIONS_DIR));

  if (!inClaude && !inCodex) {
    throw new Error('安全拦截: 禁止删除非 CLI 会话目录下的文件');
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('安全拦截: 仅允许删除 .jsonl 格式会话记录');
  }

  const stat = fs.statSync(resolved);
  const freedBytes = stat.size;

  fs.unlinkSync(resolved);

  // Invalidate usage cache
  summaryCache = null;
  summaryCacheTime = 0;

  return {
    ok: true,
    id: id || path.basename(resolved, '.jsonl'),
    freedBytes,
    freedFormatted: formatBytes(freedBytes),
  };
}

/**
 * 批量删除会话、按天数清理旧会话或一键清理 0 Token 空白会话
 */
async function deleteSessionsBatch({ ids = [], file_paths = [], older_than_days = null, clean_empty = false } = {}) {
  let deletedCount = 0;
  let totalFreedBytes = 0;

  if (clean_empty) {
    // 1. Scan Claude projects for 0 token sessions
    if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      const pDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
      for (const pd of pDirs) {
        const fullPd = path.join(CLAUDE_PROJECTS_DIR, pd);
        if (!fs.statSync(fullPd).isDirectory()) continue;
        const pName = parseClaudeProjectDir(pd);
        const files = fs.readdirSync(fullPd).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const fp = path.join(fullPd, f);
          try {
            const s = await parseClaudeSessionFile(fp, pName);
            if ((s.total_tokens || 0) === 0) {
              const res = deleteSession({ file_path: fp });
              if (res.ok) {
                deletedCount++;
                totalFreedBytes += res.freedBytes;
              }
            }
          } catch {}
        }
      }
    }

    // 2. Scan Codex sessions for 0 token sessions
    if (fs.existsSync(CODEX_SESSIONS_DIR)) {
      const codexFiles = findCodexRolloutFiles(CODEX_SESSIONS_DIR);
      for (const fp of codexFiles) {
        try {
          const s = await parseCodexSessionFile(fp);
          if ((s.total_tokens || 0) === 0) {
            const res = deleteSession({ file_path: fp });
            if (res.ok) {
              deletedCount++;
              totalFreedBytes += res.freedBytes;
            }
          }
        } catch {}
      }
    }
  } else if (older_than_days && Number(older_than_days) > 0) {
    const cutoffMs = Date.now() - Number(older_than_days) * 24 * 3600 * 1000;
    const targets = [];

    // Scan Claude projects
    if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      const pDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
      for (const pd of pDirs) {
        const fullPd = path.join(CLAUDE_PROJECTS_DIR, pd);
        if (!fs.statSync(fullPd).isDirectory()) continue;
        const files = fs.readdirSync(fullPd).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const fp = path.join(fullPd, f);
          try {
            const stat = fs.statSync(fp);
            if (stat.mtimeMs < cutoffMs) targets.push(fp);
          } catch {}
        }
      }
    }

    // Scan Codex sessions
    if (fs.existsSync(CODEX_SESSIONS_DIR)) {
      const codexFiles = findCodexRolloutFiles(CODEX_SESSIONS_DIR);
      for (const fp of codexFiles) {
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < cutoffMs) targets.push(fp);
        } catch {}
      }
    }

    for (const fp of targets) {
      try {
        const res = deleteSession({ file_path: fp });
        if (res.ok) {
          deletedCount++;
          totalFreedBytes += res.freedBytes;
        }
      } catch {}
    }
  } else {
    const items = [];
    if (Array.isArray(file_paths)) {
      for (const fp of file_paths) items.push({ file_path: fp });
    }
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (!items.some(i => i.id === id)) items.push({ id });
      }
    }

    for (const item of items) {
      try {
        const res = deleteSession(item);
        if (res.ok) {
          deletedCount++;
          totalFreedBytes += res.freedBytes;
        }
      } catch {}
    }
  }

  summaryCache = null;
  summaryCacheTime = 0;

  return {
    ok: true,
    deletedCount,
    freedBytes: totalFreedBytes,
    freedFormatted: formatBytes(totalFreedBytes),
  };
}

async function cleanEmptySessions() {
  return await deleteSessionsBatch({ clean_empty: true });
}

module.exports = {
  getUsageSummary,
  getSessionDetail,
  deleteSession,
  deleteSessionsBatch,
  cleanEmptySessions,
};
