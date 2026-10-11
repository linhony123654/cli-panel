'use strict';
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

let lastCpuSample = null;

function getCpuUsage() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const firstLine = stat.split('\n')[0];
    const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);

    let percent = 0;
    if (lastCpuSample) {
      const idleDiff = idle - lastCpuSample.idle;
      const totalDiff = total - lastCpuSample.total;
      if (totalDiff > 0) {
        percent = Math.max(0, Math.min(100, Math.round(((totalDiff - idleDiff) / totalDiff) * 100)));
      }
    } else {
      // Fallback to load average divided by cpu count
      const load = os.loadavg()[0];
      const cores = os.cpus().length || 1;
      percent = Math.min(100, Math.round((load / cores) * 100));
    }
    lastCpuSample = { idle, total };
    return percent;
  } catch {
    const load = os.loadavg()[0];
    const cores = os.cpus().length || 1;
    return Math.min(100, Math.round((load / cores) * 100));
  }
}

// Initial sample to warm up CPU calculation
getCpuUsage();

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时 ${m}分`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分钟`;
}

function getSystemHud() {
  // 1. CPU
  const cpuPercent = getCpuUsage();
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Generic CPU';
  const cores = cpus.length || 1;
  const loadavg = os.loadavg().map(n => Number(n.toFixed(2)));

  // 2. Memory
  let totalMem = os.totalmem();
  let availMem = os.freemem();
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const getKb = k => {
      const m = meminfo.match(new RegExp(k + ':\\s+(\\d+)'));
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    const t = getKb('MemTotal');
    const a = getKb('MemAvailable');
    if (t > 0) totalMem = t;
    if (a > 0) availMem = a;
  } catch {}

  const usedMem = totalMem - availMem;
  const memPercent = Math.max(0, Math.min(100, Math.round((usedMem / totalMem) * 100)));

  // 3. Disk
  let diskTotalGb = 0;
  let diskUsedGb = 0;
  let diskAvailGb = 0;
  let diskPercent = 0;
  try {
    const raw = execSync('df -m / 2>/dev/null', { encoding: 'utf8' }).trim();
    const lines = raw.split('\n');
    if (lines.length >= 2) {
      const cols = lines[1].split(/\s+/);
      const totalMb = parseInt(cols[1], 10);
      const usedMb = parseInt(cols[2], 10);
      const availMb = parseInt(cols[3], 10);
      diskTotalGb = Number((totalMb / 1024).toFixed(1));
      diskUsedGb = Number((usedMb / 1024).toFixed(1));
      diskAvailGb = Number((availMb / 1024).toFixed(1));
      diskPercent = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0;
    }
  } catch {}

  // 4. Node process stats
  const procMem = process.memoryUsage();

  return {
    cpu: {
      percent: cpuPercent,
      cores,
      model: cpuModel,
      loadavg,
    },
    memory: {
      percent: memPercent,
      total_gb: Number((totalMem / (1024 * 1024 * 1024)).toFixed(1)),
      used_gb: Number((usedMem / (1024 * 1024 * 1024)).toFixed(1)),
      avail_gb: Number((availMem / (1024 * 1024 * 1024)).toFixed(1)),
    },
    disk: {
      percent: diskPercent,
      total_gb: diskTotalGb,
      used_gb: diskUsedGb,
      avail_gb: diskAvailGb,
    },
    uptime: formatUptime(os.uptime()),
    process: {
      rss_mb: Math.round(procMem.rss / (1024 * 1024)),
      heap_mb: Math.round(procMem.heapUsed / (1024 * 1024)),
      pid: process.pid,
    },
    timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  };
}

module.exports = {
  getSystemHud,
};
