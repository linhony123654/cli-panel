'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const HOME = process.env.HOME || '/home/ubuntu';
const TARGET_RE = /^[a-zA-Z0-9_\-\.:]+$/;
const IDLE_SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'csh', 'tcsh', 'ksh']);

function validateTarget(target, label = 'Tmux 目标') {
  if (!target || typeof target !== 'string' || !TARGET_RE.test(target.trim())) {
    throw new Error(`无效的 ${label} 名称 (仅限数字字母横线点冒号)`);
  }
  return target.trim();
}

function formatPath(p) {
  if (!p) return '~';
  if (p === HOME) return '~';
  if (p.startsWith(HOME + '/')) return '~/' + p.slice(HOME.length + 1);
  return p;
}

function listSessions() {
  const tmuxSessions = [];
  try {
    const raw = execSync('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}|#{session_created}" 2>/dev/null', {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();

    if (raw) {
      const lines = raw.split('\n');
      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length >= 4) {
          const name = parts[0].trim();
          const windowCount = parseInt(parts[1], 10) || 1;
          const attached = parts[2].trim() === '1';
          const createdSec = parseInt(parts[3], 10);
          const created = createdSec ? new Date(createdSec * 1000).toLocaleString('zh-CN', { hour12: false }) : '';

          let windows = [];
          try {
            const winRaw = execSync(
              `tmux list-windows -t "${name}" -F "#{window_index}|#{window_name}|#{window_active}|#{window_panes}|#{pane_current_command}|#{pane_current_path}|#{pane_pid}" 2>/dev/null`,
              { encoding: 'utf8', timeout: 1500 }
            ).trim();

            if (winRaw) {
              windows = winRaw.split('\n').filter(Boolean).map(w => {
                const [idx, winName, active, panes, cmd, panePath, pid] = w.split('|');
                const command = (cmd || '').trim().toLowerCase();
                const isIdle = IDLE_SHELLS.has(command) || !command;
                const windowIndex = idx || '1';
                const target = `${name}:${windowIndex}`;

                return {
                  index: windowIndex,
                  name: winName || `win-${windowIndex}`,
                  active: active === '1',
                  panes: parseInt(panes, 10) || 1,
                  command: cmd || 'bash',
                  path: formatPath(panePath),
                  rawPath: panePath || '',
                  pid: parseInt(pid, 10) || null,
                  is_idle: isIdle,
                  status_text: isIdle ? '空闲待命 (未用到)' : `运行中 (${cmd})`,
                  target,
                  attach_cmd: `tmux select-window -t "${target}" && tmux attach -t "${name}"`,
                };
              });
            }
          } catch {}

          const idleCount = windows.filter(w => w.is_idle).length;
          const busyCount = windows.length - idleCount;

          tmuxSessions.push({
            name,
            windowCount: windows.length || windowCount,
            idleCount,
            busyCount,
            attached,
            created,
            windows,
            attach_cmd: `tmux attach -t ${name}`,
          });
        }
      }
    }
  } catch {}

  const processes = [];
  try {
    const psRaw = execSync("ps -eo pid,ppid,etimes,pmem,args 2>/dev/null", {
      encoding: 'utf8',
      timeout: 2000,
    });
    const lines = psRaw.split('\n');
    for (const l of lines) {
      if (!l.trim()) continue;
      const match = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d\.]+)\s+(.*)$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const etimes = parseInt(match[3], 10);
      const mem = parseFloat(match[4]);
      const cmd = match[5];

      // Exclude self, cli-panel, pm2 watcher, etc.
      if (
        cmd.includes('cli-panel') ||
        cmd.includes('grep') ||
        cmd.includes('tmux list-') ||
        cmd.includes('ps -eo') ||
        cmd.includes('node -e')
      ) continue;

      const isClaude = /\bclaude\b/i.test(cmd) || cmd.includes('claude-');
      const isCodex = /\bcodex\b/i.test(cmd) || cmd.includes('codex-');

      if (isClaude || isCodex) {
        // Format uptime
        let uptimeStr = `${etimes}s`;
        if (etimes > 3600) {
          uptimeStr = `${Math.floor(etimes / 3600)}h ${Math.floor((etimes % 3600) / 60)}m`;
        } else if (etimes > 60) {
          uptimeStr = `${Math.floor(etimes / 60)}m ${etimes % 60}s`;
        }

        processes.push({
          pid,
          ppid,
          type: isClaude ? 'Claude Code' : 'Codex CLI',
          uptime: uptimeStr,
          mem: `${mem}%`,
          cmd: cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd,
          fullCmd: cmd,
        });
      }
    }
  } catch {}

  return {
    tmux: tmuxSessions,
    processes,
  };
}

function killTmux(sessionName) {
  const target = validateTarget(sessionName, 'Tmux 会话');
  execSync(`tmux kill-session -t "${target}"`, { timeout: 3000 });
  return { ok: true, session: target };
}

function killTmuxWindow(target) {
  const valid = validateTarget(target, 'Tmux 窗口');
  try {
    execFileSync('tmux', ['kill-window', '-t', valid], { timeout: 3000 });
    return { ok: true, target: valid };
  } catch (err) {
    throw new Error(`关闭 Tmux 窗口失败: ${err.message}`);
  }
}

function createTmuxWindow(sessionName, windowName = 'shell', initialPath = '') {
  const sess = validateTarget(sessionName, 'Tmux 会话');
  const args = ['new-window', '-d', '-t', sess];
  if (windowName && TARGET_RE.test(windowName.trim())) {
    args.push('-n', windowName.trim());
  }
  if (initialPath && fs.existsSync(initialPath)) {
    args.push('-c', initialPath);
  }
  try {
    execFileSync('tmux', args, { timeout: 3000 });
    return { ok: true, session: sess, name: windowName || 'shell' };
  } catch (err) {
    throw new Error(`新建 Tmux 窗口失败: ${err.message}`);
  }
}

function selectTmuxWindow(target) {
  const valid = validateTarget(target, 'Tmux 目标');
  try {
    execFileSync('tmux', ['select-window', '-t', valid], { timeout: 3000 });
    return { ok: true, target: valid };
  } catch (err) {
    throw new Error(`切换 Tmux 窗口失败: ${err.message}`);
  }
}

function killCliProcess(pid) {
  const p = parseInt(pid, 10);
  if (!p || p < 100) throw new Error('无效的进程 PID');
  process.kill(p, 'SIGTERM');
  return { ok: true, pid: p };
}

function captureTmuxPane(target, lines = 120) {
  const valid = validateTarget(target || 'cc', 'Tmux 目标');
  const l = Math.min(500, Math.max(20, parseInt(lines, 10) || 120));
  try {
    const raw = execFileSync('tmux', ['capture-pane', '-p', '-t', valid, '-S', `-${l}`], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return {
      ok: true,
      target: valid,
      session: valid,
      lines: l,
      text: raw.replace(/\0/g, ''),
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    };
  } catch (err) {
    throw new Error(`读取 Tmux 输出失败: ${err.message}`);
  }
}

function sendTmuxKeys(target, text, enter = true) {
  const valid = validateTarget(target || 'cc', 'Tmux 目标');
  if (text == null) text = '';
  try {
    if (text) {
      execFileSync('tmux', ['send-keys', '-t', valid, '-l', String(text)], {
        timeout: 3000,
      });
    }
    if (enter) {
      execFileSync('tmux', ['send-keys', '-t', valid, 'Enter'], {
        timeout: 3000,
      });
    }
    return { ok: true, target: valid, session: valid, sent: text, enter: !!enter };
  } catch (err) {
    throw new Error(`向 Tmux 发送指令失败: ${err.message}`);
  }
}

function sendTmuxSignal(target, signal) {
  const valid = validateTarget(target || 'cc', 'Tmux 目标');
  try {
    let key = 'C-c';
    if (signal === 'ctrl-c' || signal === 'c-c') key = 'C-c';
    else if (signal === 'ctrl-d' || signal === 'c-d') key = 'C-d';
    else if (signal === 'enter') key = 'Enter';
    else if (signal === 'up') key = 'Up';
    else if (signal === 'down') key = 'Down';
    else throw new Error(`未知的控制信号: ${signal}`);

    execFileSync('tmux', ['send-keys', '-t', valid, key], { timeout: 3000 });
    return { ok: true, target: valid, session: valid, signal };
  } catch (err) {
    throw new Error(`发送控制信号失败: ${err.message}`);
  }
}

function cleanIdleTmuxWindows() {
  const data = listSessions();
  const closed = [];
  for (const s of data.tmux) {
    for (const w of (s.windows || [])) {
      if (w.is_idle) {
        try {
          execFileSync('tmux', ['kill-window', '-t', w.target], { timeout: 3000 });
          closed.push(w.target);
        } catch (err) {}
      }
    }
  }
  return { ok: true, closedCount: closed.length, closedTargets: closed };
}

module.exports = {
  listSessions,
  killTmux,
  killTmuxWindow,
  cleanIdleTmuxWindows,
  createTmuxWindow,
  selectTmuxWindow,
  killCliProcess,
  captureTmuxPane,
  sendTmuxKeys,
  sendTmuxSignal,
};
