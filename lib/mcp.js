'use strict';
const fs = require('fs');
const path = require('path');
const { PATHS, atomicWrite, readText, HOME } = require('./util');
const smolToml = require('smol-toml');

const CLAUDE_JSON = path.join(HOME, '.claude.json');
const CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml');

function getClaudeSettings() {
  try {
    return JSON.parse(readText(PATHS.claudeSettings, '{}'));
  } catch {
    return {};
  }
}

function saveClaudeSettings(settings) {
  atomicWrite(PATHS.claudeSettings, JSON.stringify(settings, null, 2) + '\n');
}

function listMcpServers() {
  const res = [];
  const seen = new Set();

  // 1. ~/.claude.json
  if (fs.existsSync(CLAUDE_JSON)) {
    try {
      const c = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
      for (const [id, cfg] of Object.entries(c.mcpServers || {})) {
        seen.add('claude:' + id);
        res.push({
          id,
          client: 'Claude Code',
          source: '~/.claude.json',
          command: cfg.command || (cfg.url ? 'URL: ' + cfg.url : ''),
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env: cfg.env || {},
          disabled: !!cfg.disabled,
          shortCommand: (cfg.command || cfg.url || '').replace(HOME, '~'),
        });
      }
    } catch {}
  }

  // 2. ~/.claude/settings.json
  const settings = getClaudeSettings();
  for (const [id, cfg] of Object.entries(settings.mcpServers || {})) {
    if (seen.has('claude:' + id)) continue;
    seen.add('claude:' + id);
    res.push({
      id,
      client: 'Claude Code',
      source: '~/.claude/settings.json',
      command: cfg.command || '',
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: cfg.env || {},
      disabled: !!cfg.disabled,
      shortCommand: (cfg.command || '').replace(HOME, '~'),
    });
  }

  // 3. ~/.codex/config.toml (mcp_servers)
  if (fs.existsSync(CODEX_CONFIG)) {
    try {
      const raw = fs.readFileSync(CODEX_CONFIG, 'utf8');
      const cfg = smolToml.parse(raw);
      for (const [id, srv] of Object.entries(cfg.mcp_servers || {})) {
        res.push({
          id,
          client: 'Codex CLI',
          source: '~/.codex/config.toml',
          command: srv.url ? 'URL: ' + srv.url : (srv.command || ''),
          args: Array.isArray(srv.args) ? srv.args : [],
          env: srv.bearer_token_env_var ? { [srv.bearer_token_env_var]: '(Token Env)' } : (srv.env || {}),
          disabled: srv.enabled === false,
          shortCommand: (srv.url || srv.command || '').replace(HOME, '~'),
        });
      }
    } catch {}
  }

  return res.sort((a, b) => a.id.localeCompare(b.id));
}

function saveMcpServer({ id, oldId, command, args, env, disabled }) {
  if (!id || !/^[a-zA-Z0-9_\-\.]+$/.test(id)) {
    throw new Error('MCP 服务名称必须为字母、数字、下划线、短横线或点');
  }
  if (!command) {
    throw new Error('缺少执行命令 (command)');
  }

  const settings = getClaudeSettings();
  if (!settings.mcpServers) settings.mcpServers = {};

  if (oldId && oldId !== id && settings.mcpServers[oldId]) {
    delete settings.mcpServers[oldId];
  }

  const parsedArgs = Array.isArray(args) ? args : (typeof args === 'string' ? args.trim().split(/\s+/).filter(Boolean) : []);
  const parsedEnv = typeof env === 'object' && env !== null ? env : {};

  settings.mcpServers[id] = {
    command: String(command).trim(),
    args: parsedArgs,
    env: parsedEnv,
  };
  if (disabled) {
    settings.mcpServers[id].disabled = true;
  }

  saveClaudeSettings(settings);
  return { ok: true, id };
}

function deleteMcpServer(id) {
  let deleted = false;

  // Check ~/.claude.json
  if (fs.existsSync(CLAUDE_JSON)) {
    try {
      const c = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
      if (c.mcpServers && c.mcpServers[id]) {
        delete c.mcpServers[id];
        atomicWrite(CLAUDE_JSON, JSON.stringify(c, null, 2) + '\n');
        deleted = true;
      }
    } catch {}
  }

  // Check ~/.claude/settings.json
  const settings = getClaudeSettings();
  if (settings.mcpServers && settings.mcpServers[id]) {
    delete settings.mcpServers[id];
    saveClaudeSettings(settings);
    deleted = true;
  }

  // Check ~/.codex/config.toml
  if (fs.existsSync(CODEX_CONFIG)) {
    try {
      const raw = fs.readFileSync(CODEX_CONFIG, 'utf8');
      const cfg = smolToml.parse(raw);
      if (cfg.mcp_servers && cfg.mcp_servers[id]) {
        delete cfg.mcp_servers[id];
        atomicWrite(CODEX_CONFIG, smolToml.stringify(cfg));
        deleted = true;
      }
    } catch {}
  }

  if (deleted) {
    return { ok: true, id };
  }
  return { ok: false, error: '未找到指定的 MCP 服务' };
}

module.exports = {
  listMcpServers,
  saveMcpServer,
  deleteMcpServer,
};
