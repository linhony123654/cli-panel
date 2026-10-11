'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');
const { HOME, PATHS, atomicWrite, backup } = require('./util');

const CLAUDE_JSON = path.join(HOME, '.claude.json');
const CLAUDE_DEBUG_DIR = path.join(HOME, '.claude', 'debug');
const GO_BIN_SYSTEM = '/usr/local/go/bin/go';
const GO_SYMLINK_USER = path.join(HOME, '.local', 'bin', 'go');

function checkTcpPort(port, host = '127.0.0.1', timeout = 1000) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let isConnected = false;
    socket.setTimeout(timeout);
    socket.on('connect', () => {
      isConnected = true;
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

function getDirSize(dir) {
  let size = 0;
  let count = 0;
  if (!fs.existsSync(dir)) return { size: 0, count: 0 };
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile()) {
        const stat = fs.statSync(full);
        size += stat.size;
        count++;
      } else if (ent.isDirectory()) {
        const sub = getDirSize(full);
        size += sub.size;
        count += sub.count;
      }
    }
  } catch {}
  return { size, count };
}

async function runDiagnostics() {
  const items = [];

  // 1. Trust Dialog Skip
  let trustOk = false;
  let trustDetail = '尚未配置目录信任，初次启动可能会反复弹出 Safety Check 信任提示';
  if (fs.existsSync(CLAUDE_JSON)) {
    try {
      const c = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
      if (c.hasTrustDialogAccepted === true) {
        trustOk = true;
        trustDetail = '已开启 hasTrustDialogAccepted，启动时将自动跳过目录信任弹窗';
      }
    } catch {}
  }
  items.push({
    id: 'trust_dialog',
    title: 'Claude Code 目录信任提示',
    status: trustOk ? 'ok' : 'warning',
    detail: trustDetail,
    can_fix: !trustOk,
    fix_label: '一键跳过信任弹窗',
  });

  // 2. Go Runtime in PATH
  let goOk = false;
  let goDetail = '';
  let canFixGo = false;
  const goInstalled = fs.existsSync(GO_BIN_SYSTEM);

  if (goInstalled) {
    if (fs.existsSync(GO_SYMLINK_USER)) {
      goOk = true;
      goDetail = 'Go 运行时安装于 /usr/local/go/bin/go，且已软链至 ~/.local/bin/go (PATH 正常)';
    } else {
      goDetail = 'Go 运行时存在于 /usr/local/go/bin/go，但未软链至 ~/.local/bin/go，可能导致非交互命令找不到 go';
      canFixGo = true;
    }
  } else {
    goDetail = '未在 /usr/local/go/bin/go 找到 Go 运行时 (可按需安装)';
  }
  items.push({
    id: 'go_runtime',
    title: 'Go 语言运行时与 PATH 链',
    status: goOk ? 'ok' : (canFixGo ? 'warning' : 'info'),
    detail: goDetail,
    can_fix: canFixGo,
    fix_label: '软链到 ~/.local/bin/go',
  });

  // 3. Cache & Debug Logs Size
  const debugStats = getDirSize(CLAUDE_DEBUG_DIR);
  const debugMb = (debugStats.size / (1024 * 1024)).toFixed(2);
  const cacheHigh = debugStats.size > 10 * 1024 * 1024 || debugStats.count > 30;
  items.push({
    id: 'claude_cache',
    title: '~/.claude 调试日志与临时缓存',
    status: cacheHigh ? 'warning' : 'ok',
    detail: `当前 debug/ 目录占用 ${debugMb} MB (${debugStats.count} 个日志文件)` + (cacheHigh ? '，建议清理旧日志以释放空间' : '，体积正常'),
    can_fix: debugStats.count > 0,
    fix_label: '清理 3 天前的日志',
  });

  // 4. Effort Env Hard-lock Check
  let effortLocked = false;
  let effortDetail = '未在 settings.json 中硬锁定 CLAUDE_CODE_EFFORT_LEVEL，终端可自由切换 /effort';
  try {
    const s = JSON.parse(fs.readFileSync(PATHS.claudeSettings, 'utf8'));
    if (s.env && s.env.CLAUDE_CODE_EFFORT_LEVEL) {
      effortLocked = true;
      effortDetail = `检测到 settings.json 中硬锁定了 CLAUDE_CODE_EFFORT_LEVEL="${s.env.CLAUDE_CODE_EFFORT_LEVEL}"，会导致交互终端中的 /effort 档位失效。推荐通过启动器参数 --effort 传递。`;
    }
  } catch {}
  items.push({
    id: 'effort_lock',
    title: 'Claude Effort 思考档位环境变量',
    status: effortLocked ? 'warning' : 'ok',
    detail: effortDetail,
    can_fix: effortLocked,
    fix_label: '解除环境变量死锁',
  });

  // 5. CPA Switch / Local Proxy Port
  const cpa8899 = await checkTcpPort(8899);
  items.push({
    id: 'cpa_port_8899',
    title: '本地反代服务 (端口 8899 - CPA Switch)',
    status: cpa8899 ? 'ok' : 'info',
    detail: cpa8899 ? '端口 8899 监听正常 (cliproxy-switch 在线)' : '端口 8899 未处于监听状态 (未启动或已退役)',
    can_fix: false,
    fix_label: null,
  });

  return items;
}

async function runFix(checkId) {
  if (checkId === 'trust_dialog') {
    let cfg = {};
    if (fs.existsSync(CLAUDE_JSON)) {
      try { cfg = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')); } catch {}
    }
    cfg.hasCompletedOnboarding = true;
    cfg.hasTrustDialogAccepted = true;
    backup(CLAUDE_JSON);
    atomicWrite(CLAUDE_JSON, JSON.stringify(cfg, null, 2) + '\n');
    return { ok: true, message: '已写入 hasTrustDialogAccepted: true，已跳过目录信任提示' };
  }

  if (checkId === 'go_runtime') {
    if (!fs.existsSync(GO_BIN_SYSTEM)) throw new Error('未在系统路径找到 /usr/local/go/bin/go');
    fs.mkdirSync(path.dirname(GO_SYMLINK_USER), { recursive: true });
    if (fs.existsSync(GO_SYMLINK_USER)) fs.unlinkSync(GO_SYMLINK_USER);
    fs.symlinkSync(GO_BIN_SYSTEM, GO_SYMLINK_USER);
    return { ok: true, message: '已成功创建软链 ~/.local/bin/go -> /usr/local/go/bin/go' };
  }

  if (checkId === 'claude_cache') {
    if (!fs.existsSync(CLAUDE_DEBUG_DIR)) return { ok: true, message: '无需要清理的日志' };
    const files = fs.readdirSync(CLAUDE_DEBUG_DIR);
    const threeDaysAgo = Date.now() - 3 * 24 * 3600 * 1000;
    let deleted = 0;
    for (const f of files) {
      const full = path.join(CLAUDE_DEBUG_DIR, f);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.mtimeMs < threeDaysAgo) {
          fs.unlinkSync(full);
          deleted++;
        }
      } catch {}
    }
    return { ok: true, message: `已清理 ${deleted} 个旧调试日志文件` };
  }

  if (checkId === 'effort_lock') {
    let s = {};
    if (fs.existsSync(PATHS.claudeSettings)) {
      try { s = JSON.parse(fs.readFileSync(PATHS.claudeSettings, 'utf8')); } catch {}
    }
    if (s.env && s.env.CLAUDE_CODE_EFFORT_LEVEL) {
      delete s.env.CLAUDE_CODE_EFFORT_LEVEL;
      if (Object.keys(s.env).length === 0) delete s.env;
      backup(PATHS.claudeSettings);
      atomicWrite(PATHS.claudeSettings, JSON.stringify(s, null, 2) + '\n');
      return { ok: true, message: '已从 settings.json 中移除 CLAUDE_CODE_EFFORT_LEVEL，终端可自由使用 /effort' };
    }
    return { ok: true, message: '未检测到硬锁，无需处理' };
  }

  throw new Error(`未知的体检修复项: ${checkId}`);
}

module.exports = {
  runDiagnostics,
  runFix,
};
