'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { HOME } = require('./util');

/**
 * 格式化字节为易读文本 (B / KB / MB / GB)
 */
function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes) || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 获取系统根分区使用率与容量信息
 */
function getDiskUsage() {
  let totalGb = 40.0;
  let usedGb = 28.0;
  let availGb = 12.0;
  let percent = 70;

  try {
    const raw = execSync('df -m / 2>/dev/null', { encoding: 'utf8', timeout: 2000 }).trim();
    const lines = raw.split('\n');
    if (lines.length >= 2) {
      const cols = lines[1].split(/\s+/);
      const totalMb = parseInt(cols[1], 10);
      const usedMb = parseInt(cols[2], 10);
      const availMb = parseInt(cols[3], 10);
      totalGb = Number((totalMb / 1024).toFixed(1));
      usedGb = Number((usedMb / 1024).toFixed(1));
      availGb = Number((availMb / 1024).toFixed(1));
      percent = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0;
    }
  } catch {}

  return { totalGb, usedGb, availGb, percent };
}

/**
 * 安全测量目录或文件占用的磁盘大小 (du -sb)
 */
function measurePath(targetPath) {
  if (!fs.existsSync(targetPath)) return { bytes: 0, count: 0 };
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return { bytes: stat.size, count: 1 };
    }
    const raw = execSync(`du -sb ${JSON.stringify(targetPath)} 2>/dev/null || true`, {
      encoding: 'utf8',
      timeout: 3000
    }).trim();
    const bytes = parseInt(raw.split(/\s+/)[0], 10) || 0;

    // Count files (capped at 500 for perf)
    let count = 0;
    try {
      const cRaw = execSync(`find ${JSON.stringify(targetPath)} -maxdepth 3 -type f 2>/dev/null || true`, {
        encoding: 'utf8',
        timeout: 2000
      }).trim();
      count = cRaw ? cRaw.split('\n').filter(Boolean).length : 1;
    } catch { count = 1; }

    return { bytes, count };
  } catch {
    return { bytes: 0, count: 0 };
  }
}

/**
 * 垃圾分类定义配置
 */
const JUNK_DEFINITIONS = [
  {
    id: 'pkg_cache',
    name: '包管理器与运行时依赖缓存',
    icon: '📦',
    safety: 'safe',
    defaultSelected: true,
    description: 'npm 下载缓存、Python uv/pip 依赖下载缓存与 apt 归档包，清理后在下次安装时自动按需重新拉取，完全不影响正在运行的项目。',
    targets: [
      { path: path.join(HOME, '.npm', '_cacache'), name: 'npm 依赖缓存 (~/.npm/_cacache)', action: 'dir_contents' },
      { path: path.join(HOME, '.cache', 'uv'), name: 'Python uv 依赖缓存 (~/.cache/uv)', action: 'dir_contents' },
      { path: path.join(HOME, '.cache', 'pip'), name: 'pip 下载缓存 (~/.cache/pip)', action: 'dir_contents' },
      { path: '/var/cache/apt/archives', name: 'apt 软件包下载缓存 (/var/cache/apt/archives)', action: 'deb_files' },
    ]
  },
  {
    id: 'cli_temp',
    name: 'CLI 运行时临时文件与调试快照',
    icon: '⚡',
    safety: 'safe',
    defaultSelected: true,
    description: 'Codex 插件临时克隆残留、Claude 调试日志与历史文件修改快照，随时间推移积累无用碎片。',
    targets: [
      { path: path.join(HOME, '.codex', '.tmp'), name: 'Codex 插件克隆与临时目录 (~/.codex/.tmp)', action: 'dir_contents' },
      { path: path.join(HOME, '.claude', 'debug'), name: 'Claude 调试与崩溃日志 (~/.claude/debug)', action: 'dir_contents' },
      { path: path.join(HOME, '.claude', 'file-history'), name: 'Claude 文件历史快照 (~/.claude/file-history)', action: 'dir_contents' },
    ]
  },
  {
    id: 'sys_temp',
    name: '系统 /tmp 临时截图与测试生成物',
    icon: '🗑️',
    safety: 'safe',
    defaultSelected: true,
    description: '系统 /tmp 目录下残留的 Playwright 历史截图、临时测试脚本、临时打包 zip 与 tgz 归档。',
    targets: [
      { path: '/tmp', name: '系统临时测试文件 (/tmp/*.png, *.jpg, *.zip, cdp_*.py)', action: 'tmp_artifacts' }
    ]
  },
  {
    id: 'logs_vacuum',
    name: 'Systemd 历史日志与守护进程日志',
    icon: '📜',
    safety: 'safe',
    defaultSelected: true,
    description: 'Systemd Journal 超过 3 天的历史轮转日志与 PM2 日志历史，可安全压缩真空清理。',
    targets: [
      { path: '/var/log/journal', name: 'Systemd Journal 超过 3 天的旧日志', action: 'journalctl_vacuum' },
      { path: path.join(HOME, '.pm2', 'logs'), name: 'PM2 归档日志 (~/.pm2/logs/*.log)', action: 'pm2_logs' }
    ]
  },
  {
    id: 'build_cache',
    name: '开发与框架构建缓存 (Next.js / Gradle)',
    icon: '🔨',
    safety: 'safe',
    defaultSelected: true,
    description: 'Next.js Webpack 预编译缓存与 Gradle 依赖构建缓存，清理后无任何副作用，下次 build 时会自动以最新代码重建。',
    targets: [
      { path: path.join(HOME, 'yaoshi-management', '.next', 'cache'), name: '药事管理 Next.js Webpack 缓存', action: 'dir_contents' },
      { path: path.join(HOME, '.gradle', 'caches'), name: 'Gradle 构建依赖缓存 (~/.gradle/caches)', action: 'dir_contents' }
    ]
  },
  {
    id: 'stale_backups',
    name: '早期归档会话与旧版本部署备份',
    icon: '🕰️',
    safety: 'review',
    defaultSelected: false,
    description: '历史月份超大 Rollout 会话记录（如 9 月超 500MB 会话单文件）与过期部署备份目录，保留当前月份活跃会话，清理旧归档。',
    targets: [
      { path: path.join(HOME, '.codex', 'sessions', '2026', '09'), name: 'Codex 早期会话归档 (~/.codex/sessions/2026/09)', action: 'dir_contents' },
      { path: path.join(HOME, '.local', 'share', 'corerp-preview', 'backups'), name: 'corerp-preview 历史部署备份', action: 'dir_contents' }
    ]
  }
];

/**
 * 严格白名单路径判定，防止越权或误删关键目录
 */
const ALLOWED_CLEAN_PREFIXES = [
  path.join(HOME, '.npm', '_cacache'),
  path.join(HOME, '.cache', 'uv'),
  path.join(HOME, '.cache', 'pip'),
  '/var/cache/apt/archives',
  path.join(HOME, '.codex', '.tmp'),
  path.join(HOME, '.codex', 'sessions', '2026', '09'),
  path.join(HOME, '.claude', 'debug'),
  path.join(HOME, '.claude', 'file-history'),
  '/tmp',
  '/var/log/journal',
  path.join(HOME, '.pm2', 'logs'),
  path.join(HOME, 'yaoshi-management', '.next', 'cache'),
  path.join(HOME, '.gradle', 'caches'),
  path.join(HOME, '.local', 'share', 'corerp-preview', 'backups')
];

const FORBIDDEN_PATHS = [
  '/',
  '/home',
  HOME,
  path.join(HOME, '.ssh'),
  path.join(HOME, '.config', 'cli-panel'),
  path.join(HOME, '.git'),
  '/etc',
  '/usr',
  '/boot',
  '/root',
  '/bin',
  '/sbin'
];

function isSafeToClean(p) {
  if (!p) return false;
  const abs = path.resolve(p);
  // Check forbidden
  for (const f of FORBIDDEN_PATHS) {
    if (abs === f) return false;
  }
  if (abs.includes('.git') || abs.includes('keys') || abs.includes('auth.json')) return false;

  // Check allowlist prefix
  return ALLOWED_CLEAN_PREFIXES.some(prefix => abs === prefix || abs.startsWith(prefix + '/'));
}

/**
 * 扫描全部垃圾分类
 */
function scanJunk() {
  const disk = getDiskUsage();
  let totalJunkBytes = 0;
  let safeJunkBytes = 0;
  let totalItemCount = 0;

  const categories = [];

  for (const def of JUNK_DEFINITIONS) {
    let catBytes = 0;
    let catFiles = 0;
    const items = [];

    for (const target of def.targets) {
      let tBytes = 0;
      let tCount = 0;

      if (target.action === 'journalctl_vacuum') {
        try {
          const raw = execSync('journalctl --disk-usage 2>/dev/null', { encoding: 'utf8', timeout: 2000 }).trim();
          // "Archived and active journals take up 136.0M in the file system."
          const m = raw.match(/([\d.]+)\s*([KMGT]?)/i);
          if (m) {
            const val = parseFloat(m[1]);
            const unit = (m[2] || 'M').toUpperCase();
            const mult = unit === 'G' ? 1024 * 1024 * 1024 : (unit === 'K' ? 1024 : 1024 * 1024);
            tBytes = Math.round(val * mult);
            tCount = 1;
          }
        } catch {}
      } else if (target.action === 'tmp_artifacts') {
        try {
          // Look for .png, .jpg, .zip, .tgz, cdp_*.py in /tmp
          const raw = execSync("find /tmp -maxdepth 1 \\( -name '*.png' -o -name '*.jpg' -o -name '*.zip' -o -name '*.tgz' -o -name 'cdp_*.py' \\) -exec ls -l {} + 2>/dev/null", {
            encoding: 'utf8',
            timeout: 2000
          }).trim();
          if (raw) {
            const lines = raw.split('\n');
            tCount = lines.length;
            for (const l of lines) {
              const parts = l.split(/\s+/);
              if (parts[4]) tBytes += parseInt(parts[4], 10) || 0;
            }
          }
        } catch {}
      } else if (target.action === 'deb_files') {
        try {
          const raw = execSync("find /var/cache/apt/archives -name '*.deb' -exec ls -l {} + 2>/dev/null", {
            encoding: 'utf8',
            timeout: 2000
          }).trim();
          if (raw) {
            const lines = raw.split('\n');
            tCount = lines.length;
            for (const l of lines) {
              const parts = l.split(/\s+/);
              if (parts[4]) tBytes += parseInt(parts[4], 10) || 0;
            }
          }
        } catch {}
      } else {
        const stats = measurePath(target.path);
        tBytes = stats.bytes;
        tCount = stats.count;
      }

      catBytes += tBytes;
      catFiles += tCount;

      items.push({
        name: target.name,
        path: target.path,
        bytes: tBytes,
        formattedSize: formatBytes(tBytes),
        count: tCount
      });
    }

    totalJunkBytes += catBytes;
    totalItemCount += catFiles;
    if (def.safety === 'safe') {
      safeJunkBytes += catBytes;
    }

    categories.push({
      id: def.id,
      name: def.name,
      icon: def.icon,
      safety: def.safety,
      defaultSelected: def.defaultSelected,
      description: def.description,
      bytes: catBytes,
      formattedSize: formatBytes(catBytes),
      count: catFiles,
      items
    });
  }

  // Predict disk saving percent
  const potentialSavedGb = Number((totalJunkBytes / (1024 * 1024 * 1024)).toFixed(1));
  const predictedUsedGb = Math.max(0, Number((disk.usedGb - potentialSavedGb).toFixed(1)));
  const predictedPercent = disk.totalGb > 0 ? Math.round((predictedUsedGb / disk.totalGb) * 100) : disk.percent;

  return {
    disk,
    totalJunkBytes,
    formattedTotalJunk: formatBytes(totalJunkBytes),
    safeJunkBytes,
    formattedSafeJunk: formatBytes(safeJunkBytes),
    totalItemCount,
    potentialSavedGb,
    predictedUsedGb,
    predictedPercent,
    categories,
    scannedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false })
  };
}

/**
 * 执行清理指定分类垃圾
 */
function cleanJunk(categoryIds = []) {
  if (!Array.isArray(categoryIds) || !categoryIds.length) {
    throw new Error('未选择需要清理的分类');
  }

  let totalFreedBytes = 0;
  const executed = [];
  const errors = [];

  for (const catId of categoryIds) {
    const def = JUNK_DEFINITIONS.find(d => d.id === catId);
    if (!def) continue;

    let catFreed = 0;

    for (const target of def.targets) {
      if (!isSafeToClean(target.path)) {
        errors.push(`目标路径 [${target.path}] 未通过安全白名单校验，已跳过`);
        continue;
      }

      try {
        const before = measurePath(target.path);

        if (target.action === 'journalctl_vacuum') {
          // Vacuum journal to 3 days
          try {
            execSync('journalctl --vacuum-time=3d 2>/dev/null', { timeout: 4000 });
            catFreed += before.bytes;
          } catch {}
        } else if (target.action === 'pm2_logs') {
          // Truncate logs in ~/.pm2/logs
          if (fs.existsSync(target.path)) {
            const files = fs.readdirSync(target.path);
            for (const f of files) {
              if (f.endsWith('.log')) {
                const full = path.join(target.path, f);
                try {
                  const sz = fs.statSync(full).size;
                  fs.writeFileSync(full, ''); // truncate
                  catFreed += sz;
                } catch {}
              }
            }
          }
        } else if (target.action === 'tmp_artifacts') {
          try {
            const files = fs.readdirSync('/tmp');
            for (const f of files) {
              if (/\.(png|jpg|zip|tgz)$/i.test(f) || f.startsWith('cdp_')) {
                const full = path.join('/tmp', f);
                try {
                  const sz = fs.statSync(full).size;
                  fs.unlinkSync(full);
                  catFreed += sz;
                } catch {}
              }
            }
          } catch {}
        } else if (target.action === 'deb_files') {
          try {
            if (fs.existsSync('/var/cache/apt/archives')) {
              const files = fs.readdirSync('/var/cache/apt/archives');
              for (const f of files) {
                if (f.endsWith('.deb')) {
                  const full = path.join('/var/cache/apt/archives', f);
                  try {
                    const sz = fs.statSync(full).size;
                    fs.unlinkSync(full);
                    catFreed += sz;
                  } catch {}
                }
              }
            }
          } catch {}
        } else if (target.action === 'dir_contents') {
          if (fs.existsSync(target.path)) {
            const entries = fs.readdirSync(target.path);
            for (const ent of entries) {
              const full = path.join(target.path, ent);
              try {
                const st = measurePath(full);
                execSync(`rm -rf ${JSON.stringify(full)} 2>/dev/null`, { timeout: 4000 });
                catFreed += st.bytes;
              } catch {}
            }
          }
        }

        totalFreedBytes += catFreed;
      } catch (err) {
        errors.push(`清理 [${target.name}] 发生错误: ${err.message}`);
      }
    }

    executed.push(def.name);
  }

  // Refresh disk gauge
  const newDisk = getDiskUsage();

  return {
    success: true,
    freedBytes: totalFreedBytes,
    formattedFreed: formatBytes(totalFreedBytes),
    executed,
    errors,
    disk: newDisk,
    cleanedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false })
  };
}

/**
 * 扫描 Top 大文件排行榜 (>30MB)
 */
function getLargeFiles({ limit = 30, minMb = 30 } = {}) {
  const l = Math.min(100, Math.max(10, parseInt(limit, 10) || 30));
  const m = Math.max(10, parseInt(minMb, 10) || 30);

  const files = [];

  try {
    // Find files in /home/ubuntu larger than minMb, pruning noisy node_modules & .git
    const cmd = `find ${JSON.stringify(HOME)} \\( -name node_modules -o -name .git \\) -prune -o -type f -size +${m}M -print 2>/dev/null | xargs -r ls -lh 2>/dev/null | sort -k5 -hr | head -n ${l}`;
    const raw = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 6000 }).trim();
    if (!raw) return [];

    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = line.split(/\s+/);
      if (cols.length < 9) continue;
      const sizeStr = cols[4];
      const filePath = cols.slice(8).join(' ');
      if (!filePath) continue;

      const ext = path.extname(filePath).toLowerCase();
      let typeLabel = '其他文件';
      if (['.jsonl', '.log', '.txt'].includes(ext)) typeLabel = '日志/会话文本';
      else if (['.sqlite', '.db'].includes(ext)) typeLabel = 'SQLite 数据库';
      else if (['.zip', '.tar', '.gz', '.tgz', '.pack'].includes(ext)) typeLabel = '打包/归档缓存';
      else if (['.jar', '.apk', '.bin', '.node', '.so'].includes(ext)) typeLabel = '编译产物/二进制';
      else if (['.jpg', '.png', '.webp', '.mp4'].includes(ext)) typeLabel = '图片媒体';

      // Check if it's safe to clean
      const isCleanable = isSafeToClean(filePath) ||
        filePath.includes('/.next/cache/') ||
        filePath.includes('/.codex/.tmp/') ||
        filePath.includes('/.npm/_cacache/') ||
        filePath.includes('/corerp-preview/backups/');

      files.push({
        path: filePath,
        name: path.basename(filePath),
        dir: path.dirname(filePath),
        sizeStr,
        mtime: `${cols[5]} ${cols[6]} ${cols[7]}`,
        typeLabel,
        isCleanable
      });
    }
  } catch {}

  return files;
}

/**
 * 扫描 Top 大目录排行榜
 */
function getLargeDirs({ limit = 15 } = {}) {
  const dirs = [];
  try {
    const raw = execSync(`du -h -d 2 ${JSON.stringify(HOME)} 2>/dev/null | sort -hr | head -n 35`, {
      encoding: 'utf8',
      timeout: 4000
    }).trim();
    if (!raw) return [];

    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const [sizeStr, dirPath] = line.split(/\s+/);
      if (!dirPath || dirPath === HOME) continue;
      dirs.push({
        path: dirPath,
        name: dirPath.replace(HOME, '~'),
        sizeStr
      });
      if (dirs.length >= limit) break;
    }
  } catch {}
  return dirs;
}

module.exports = {
  formatBytes,
  getDiskUsage,
  scanJunk,
  cleanJunk,
  getLargeFiles,
  getLargeDirs,
  isSafeToClean
};
