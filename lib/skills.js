'use strict';
const fs = require('fs');
const path = require('path');
const { HOME, atomicWrite } = require('./util');

const DIRS = {
  claude: path.join(HOME, '.claude', 'skills'),
  codex: path.join(HOME, '.codex', 'skills'),
  kimi: path.join(HOME, '.kimi', 'skills'),
  'kimi-code': path.join(HOME, '.kimi-code', 'skills'),
};

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text.trim() };

  const rawYaml = match[1];
  const body = match[2].trim();
  const meta = {};

  // Simple, robust line-by-line parser for skill frontmatter
  const lines = rawYaml.split(/\r?\n/);
  let curKey = null;
  let curVal = '';
  let inMultiLine = false;

  for (const line of lines) {
    const keyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      if (curKey) meta[curKey] = curVal.trim();
      curKey = keyMatch[1];
      const rest = keyMatch[2].trim();
      if (rest === '>' || rest === '|') {
        inMultiLine = true;
        curVal = '';
      } else {
        inMultiLine = false;
        curVal = rest.replace(/^['"]|['"]$/g, '');
      }
    } else if (inMultiLine && curKey) {
      curVal += ' ' + line.trim();
    }
  }
  if (curKey) meta[curKey] = curVal.trim();

  return { meta, body };
}

function serializeSkill(meta, body) {
  const lines = ['---'];
  if (meta.name) lines.push(`name: ${meta.name}`);
  if (meta.description) {
    if (meta.description.length > 60 || meta.description.includes('\n')) {
      lines.push('description: >');
      const words = meta.description.replace(/\r?\n/g, ' ').trim();
      lines.push('  ' + words);
    } else {
      lines.push(`description: ${meta.description}`);
    }
  }
  for (const [k, v] of Object.entries(meta)) {
    if (['name', 'description'].includes(k)) continue;
    if (typeof v === 'string') lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(body.trim());
  lines.push('');
  return lines.join('\n');
}

function listSkills() {
  const skillMap = new Map();

  for (const [targetKey, dir] of Object.entries(DIRS)) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }

    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const skillId = ent.name;
      const skillPath = path.join(dir, skillId, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      let stat;
      let raw = '';
      try {
        stat = fs.statSync(skillPath);
        raw = fs.readFileSync(skillPath, 'utf8');
      } catch { continue; }

      const parsed = parseFrontmatter(raw);
      const name = parsed.meta.name || skillId;
      const desc = parsed.meta.description || '';

      if (!skillMap.has(skillId)) {
        skillMap.set(skillId, {
          id: skillId,
          name,
          description: desc,
          targets: [targetKey],
          paths: { [targetKey]: skillPath.replace(HOME, '~') },
          updated: stat.mtime.toISOString(),
          contentPreview: parsed.body.slice(0, 150),
          fullContent: raw,
        });
      } else {
        const item = skillMap.get(skillId);
        if (!item.targets.includes(targetKey)) {
          item.targets.push(targetKey);
          item.paths[targetKey] = skillPath.replace(HOME, '~');
        }
      }
    }
  }

  return Array.from(skillMap.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function getSkill(skillId) {
  const skills = listSkills();
  return skills.find(s => s.id === skillId) || null;
}

function saveSkill({ id, name, description, content, targets = ['claude', 'codex'] }) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('Skill ID 必须为字母、数字、下划线或短横线');
  }

  const meta = {
    name: name || id,
    description: description || '',
  };

  // If content already includes frontmatter, parse it first to avoid double frontmatter
  let body = content || '';
  if (body.startsWith('---')) {
    const p = parseFrontmatter(body);
    if (!name && p.meta.name) meta.name = p.meta.name;
    if (!description && p.meta.description) meta.description = p.meta.description;
    body = p.body;
  }

  const fullText = serializeSkill(meta, body);
  const written = [];

  for (const t of targets) {
    const baseDir = DIRS[t];
    if (!baseDir) continue;
    const skillDir = path.join(baseDir, id);
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }
    const skillPath = path.join(skillDir, 'SKILL.md');
    atomicWrite(skillPath, fullText);
    written.push(t);
  }

  return { ok: true, id, targets: written };
}

function deleteSkill(id, target = 'all') {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('无效的 Skill ID');
  }

  const targetsToDelete = target === 'all' ? Object.keys(DIRS) : [target];
  let deletedCount = 0;

  for (const t of targetsToDelete) {
    const baseDir = DIRS[t];
    if (!baseDir) continue;
    const skillDir = path.join(baseDir, id);
    if (fs.existsSync(skillDir)) {
      try {
        fs.rmSync(skillDir, { recursive: true, force: true });
        deletedCount++;
      } catch {}
    }
  }

  return { ok: true, deletedCount };
}

module.exports = {
  listSkills,
  getSkill,
  saveSkill,
  deleteSkill,
  DIRS,
};
