'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { HOME } = require('./util');

function runGit(args, cwd) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 8000, maxBuffer: 1024 * 1024 * 2 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        code: err ? err.code : 0,
      });
    });
  });
}

// Discover git repos under HOME (/home/ubuntu)
function getKnownRepoDirs() {
  const dirs = [HOME]; // Include workspace root
  try {
    const entries = fs.readdirSync(HOME, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') && ent.name !== '.local') continue;
      if (ent.name === 'node_modules' || ent.name === 'snap') continue;
      const sub = path.join(HOME, ent.name);
      if (fs.existsSync(path.join(sub, '.git'))) {
        dirs.push(sub);
      }
    }
  } catch {}
  return [...new Set(dirs)];
}

function resolveRepoPath(id) {
  if (!id || typeof id !== 'string') return null;
  const cleanId = id.trim();
  if (cleanId === 'workspace' || cleanId === 'home' || cleanId === '~') return HOME;
  const p = path.resolve(HOME, cleanId);
  if (!p.startsWith(HOME)) return null;
  if (fs.existsSync(path.join(p, '.git')) || (p === HOME && fs.existsSync(path.join(HOME, '.git')))) {
    return p;
  }
  return null;
}

async function listRepos() {
  const dirs = getKnownRepoDirs();
  const list = [];

  for (const dir of dirs) {
    const id = dir === HOME ? '~' : path.basename(dir);
    const name = dir === HOME ? '工作区根目录 (~)' : path.basename(dir);

    // 1. Branch and status
    const stRes = await runGit(['status', '--porcelain=v1', '-b'], dir);
    if (!stRes.ok) continue;

    const lines = stRes.stdout ? stRes.stdout.split('\n') : [];
    const header = lines[0] || '';
    const fileLines = lines.slice(1).filter(Boolean);

    let branch = 'HEAD';
    let ahead = 0;
    let behind = 0;

    const bMatch = header.match(/^##\s+([^.\s]+)(?:\.\.\.([^\s]+))?(?:\s+\[(.*)\])?/);
    if (bMatch) {
      branch = bMatch[1];
      const tracker = bMatch[3] || '';
      const aheadMatch = tracker.match(/ahead\s+(\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
      const behindMatch = tracker.match(/behind\s+(\d+)/);
      if (behindMatch) behind = parseInt(behindMatch[1], 10);
    } else if (header.startsWith('## HEAD (no branch)')) {
      branch = 'detached';
    }

    let untracked = 0;
    let modified = 0;
    let staged = 0;
    let deleted = 0;

    for (const fl of fileLines) {
      const x = fl[0];
      const y = fl[1];
      if (fl.startsWith('??')) {
        untracked++;
      } else {
        if (x !== ' ' && x !== '?') staged++;
        if (y === 'M' || x === 'M') modified++;
        if (y === 'D' || x === 'D') deleted++;
      }
    }

    // 2. Latest Commit
    const logRes = await runGit(['log', '-1', '--format=%h|%an|%ar|%s'], dir);
    let lastCommit = null;
    if (logRes.ok && logRes.stdout) {
      const [hash, author, time, subject] = logRes.stdout.split('|');
      lastCommit = { hash, author, time, subject };
    }

    list.push({
      id,
      name,
      path: dir.replace(HOME, '~'),
      branch,
      ahead,
      behind,
      is_clean: fileLines.length === 0,
      changes: {
        total: fileLines.length,
        untracked,
        modified,
        staged,
        deleted,
      },
      last_commit: lastCommit,
    });
  }

  // Sort: dirty repos first, then by name
  return list.sort((a, b) => {
    if (!a.is_clean && b.is_clean) return -1;
    if (a.is_clean && !b.is_clean) return 1;
    return a.name.localeCompare(b.name);
  });
}

async function getRepoDiff(id) {
  const repoPath = resolveRepoPath(id);
  if (!repoPath) throw new Error('指定的 Git 仓库不存在或无权限访问');

  // File status list
  const stRes = await runGit(['status', '--porcelain=v1'], repoPath);
  const files = [];
  if (stRes.ok && stRes.stdout) {
    for (const l of stRes.stdout.split('\n')) {
      if (!l.trim()) continue;
      const status = l.slice(0, 2);
      const filePath = l.slice(3).trim().replace(/^"|"$/g, '');
      files.push({
        status: status.trim(),
        path: filePath,
        is_untracked: status.startsWith('??'),
        is_staged: status[0] !== ' ' && status[0] !== '?',
      });
    }
  }

  // Diff
  const diffRes = await runGit(['diff', 'HEAD', '--no-color'], repoPath);
  let diffText = diffRes.stdout || '';

  // If HEAD diff is empty but there are untracked files, get untracked file previews
  if (!diffText && files.some(f => f.is_untracked)) {
    const untrackedPreviews = [];
    for (const f of files.filter(x => x.is_untracked).slice(0, 5)) {
      try {
        const fullP = path.join(repoPath, f.path);
        const stat = fs.statSync(fullP);
        if (stat.isFile() && stat.size < 64 * 1024) {
          const content = fs.readFileSync(fullP, 'utf8');
          untrackedPreviews.push(`--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${content.split('\n').length} @@\n${content.split('\n').map(l => '+' + l).join('\n')}`);
        }
      } catch {}
    }
    diffText = untrackedPreviews.join('\n\n');
  }

  return {
    id,
    repo_path: repoPath.replace(HOME, '~'),
    files,
    diff: diffText.slice(0, 500000), // Cap at 500KB for web performance
    truncated: diffText.length > 500000,
  };
}

async function repoAction(id, action, params = {}) {
  const repoPath = resolveRepoPath(id);
  if (!repoPath) throw new Error('指定的 Git 仓库不存在或无权限访问');

  if (action === 'stash') {
    const msg = params.message ? `cli-panel: ${params.message}` : `cli-panel-stash-${Date.now()}`;
    const res = await runGit(['stash', 'push', '-u', '-m', msg], repoPath);
    if (!res.ok) throw new Error(res.stderr || 'Stash 失败');
    return { ok: true, message: res.stdout || '已暂存所有改动' };
  }

  if (action === 'stash_pop') {
    const res = await runGit(['stash', 'pop'], repoPath);
    if (!res.ok) throw new Error(res.stderr || 'Stash Pop 失败');
    return { ok: true, message: res.stdout || '已弹出最近暂存' };
  }

  if (action === 'commit') {
    const msg = String(params.message || '').trim();
    if (!msg) throw new Error('提交信息 (Commit message) 不能为空');
    const addRes = await runGit(['add', '-A'], repoPath);
    if (!addRes.ok) throw new Error(addRes.stderr || 'Git add 失败');
    const commitRes = await runGit(['commit', '-m', msg], repoPath);
    if (!commitRes.ok) throw new Error(commitRes.stderr || 'Git commit 失败');
    return { ok: true, message: commitRes.stdout || '已成功提交' };
  }

  if (action === 'discard') {
    const file = String(params.file || '').trim();
    if (!file) throw new Error('缺少要放弃更改的文件路径');
    // Security check: must not escape repo
    const targetFile = path.resolve(repoPath, file);
    if (!targetFile.startsWith(repoPath)) throw new Error('非法的文件路径');

    // If untracked
    const stRes = await runGit(['status', '--porcelain', file], repoPath);
    if (stRes.stdout && stRes.stdout.startsWith('??')) {
      if (fs.existsSync(targetFile)) {
        if (fs.statSync(targetFile).isDirectory()) {
          fs.rmSync(targetFile, { recursive: true, force: true });
        } else {
          fs.unlinkSync(targetFile);
        }
      }
    } else {
      await runGit(['checkout', '--', file], repoPath);
    }
    return { ok: true, message: `已还原 ${file}` };
  }

  throw new Error(`不支持的操作: ${action}`);
}

module.exports = {
  listRepos,
  getRepoDiff,
  repoAction,
};
