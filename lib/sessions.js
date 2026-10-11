'use strict';
const { execSync, execFileSync } = require('child_process');

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
            const winRaw = execSync(`tmux list-windows -t "${name}" -F "#{window_index}|#{window_name}|#{window_active}" 2>/dev/null`, {
              encoding: 'utf8',
              timeout: 1500,
            }).trim();
            if (winRaw) {
              windows = winRaw.split('\n').map(w => {
                const [idx, winName, active] = w.split('|');
                return { index: idx, name: winName, active: active === '1' };
              });
            }
          } catch {}

          tmuxSessions.push({
            name,
            windowCount,
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
  if (!sessionName || !/^[a-zA-Z0-9_\-\.]+$/.test(sessionName)) {
    throw new Error('无效的 Tmux 会话名称');
  }
  execSync(`tmux kill-session -t "${sessionName}"`, { timeout: 3000 });
  return { ok: true };
}

function killCliProcess(pid) {
  const p = parseInt(pid, 10);
  if (!p || p < 100) throw new Error('无效的进程 PID');
  process.kill(p, 'SIGTERM');
  return { ok: true };
}

function captureTmuxPane(sessionName, lines = 120) {
  if (!sessionName || !/^[a-zA-Z0-9_\-\.]+$/.test(sessionName)) {
    throw new Error('无效的 Tmux 会话名称');
  }
  const l = Math.min(500, Math.max(20, parseInt(lines, 10) || 120));
  try {
    const raw = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName, '-S', `-${l}`], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return {
      ok: true,
      session: sessionName,
      lines: l,
      text: raw.replace(/\0/g, ''),
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    };
  } catch (err) {
    throw new Error(`读取 Tmux 会话输出失败: ${err.message}`);
  }
}

function sendTmuxKeys(sessionName, text, enter = true) {
  if (!sessionName || !/^[a-zA-Z0-9_\-\.]+$/.test(sessionName)) {
    throw new Error('无效的 Tmux 会话名称');
  }
  if (text == null) text = '';
  try {
    if (text) {
      execFileSync('tmux', ['send-keys', '-t', sessionName, '-l', String(text)], {
        timeout: 3000,
      });
    }
    if (enter) {
      execFileSync('tmux', ['send-keys', '-t', sessionName, 'Enter'], {
        timeout: 3000,
      });
    }
    return { ok: true, session: sessionName, sent: text, enter: !!enter };
  } catch (err) {
    throw new Error(`向 Tmux 发送指令失败: ${err.message}`);
  }
}

function sendTmuxSignal(sessionName, signal) {
  if (!sessionName || !/^[a-zA-Z0-9_\-\.]+$/.test(sessionName)) {
    throw new Error('无效的 Tmux 会话名称');
  }
  try {
    let key = 'C-c';
    if (signal === 'ctrl-c' || signal === 'c-c') key = 'C-c';
    else if (signal === 'ctrl-d' || signal === 'c-d') key = 'C-d';
    else if (signal === 'enter') key = 'Enter';
    else if (signal === 'up') key = 'Up';
    else if (signal === 'down') key = 'Down';
    else throw new Error(`未知的控制信号: ${signal}`);

    execFileSync('tmux', ['send-keys', '-t', sessionName, key], { timeout: 3000 });
    return { ok: true, session: sessionName, signal };
  } catch (err) {
    throw new Error(`发送控制信号失败: ${err.message}`);
  }
}

module.exports = {
  listSessions,
  killTmux,
  killCliProcess,
  captureTmuxPane,
  sendTmuxKeys,
  sendTmuxSignal,
};
