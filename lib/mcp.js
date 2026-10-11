'use strict';
const fs = require('fs');
const path = require('path');
const { PATHS, atomicWrite, readText, HOME } = require('./util');

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
  const settings = getClaudeSettings();
  const mcp = settings.mcpServers || {};
  const res = [];

  for (const [id, cfg] of Object.entries(mcp)) {
    res.push({
      id,
      command: cfg.command || '',
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: cfg.env || {},
      disabled: !!cfg.disabled,
      shortCommand: (cfg.command || '').replace(HOME, '~'),
    });
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
  const settings = getClaudeSettings();
  if (settings.mcpServers && settings.mcpServers[id]) {
    delete settings.mcpServers[id];
    saveClaudeSettings(settings);
    return { ok: true, id };
  }
  return { ok: false, error: '未找到指定的 MCP 服务' };
}

module.exports = {
  listMcpServers,
  saveMcpServer,
  deleteMcpServer,
};
