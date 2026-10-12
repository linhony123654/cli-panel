'use strict';
const fs = require('fs');
const path = require('path');
const { HOME, backup, atomicWrite, readText } = require('./util');

const MEMORY_DIR = path.join(HOME, '.claude', 'projects', '-home-ubuntu', 'memory');
const MEMORY_INDEX_FILE = path.join(MEMORY_DIR, 'MEMORY.md');

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { data: {}, body: text };
  }

  const yamlStr = match[1];
  const body = match[2];
  const data = {};

  for (const line of yamlStr.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const kv = l.match(/^([a-zA-Z0-9_\-]+):\s*(.*)$/);
    if (kv) {
      const k = kv[1];
      let v = kv[2].trim().replace(/^['"]|['"]$/g, '');
      data[k] = v;
    }
  }

  // Handle nested metadata.type if present
  const metaMatch = yamlStr.match(/type:\s*([a-zA-Z0-9_\-]+)/);
  if (metaMatch && !data.type) {
    data.type = metaMatch[1];
  }

  return { data, body };
}

function renderFrontmatter(data, body) {
  const type = data.type || 'reference';
  const name = data.name || data.slug;
  const desc = data.description || '';

  return `---
name: ${name}
description: ${desc}
metadata:
  type: ${type}
---

${body.trim()}
`;
}

function listMemories() {
  if (!fs.existsSync(MEMORY_DIR)) return [];
  const entries = fs.readdirSync(MEMORY_DIR);
  const memories = [];

  for (const f of entries) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    const slug = path.basename(f, '.md');
    const fullPath = path.join(MEMORY_DIR, f);
    try {
      const text = fs.readFileSync(fullPath, 'utf8');
      const { data, body } = parseFrontmatter(text);
      const links = [...body.matchAll(/\[\[(.*?)\]\]/g)].map(m => m[1]);

      memories.push({
        slug,
        name: data.name || slug,
        description: data.description || '',
        type: data.type || 'reference',
        body,
        links,
        path: fullPath.replace(HOME, '~'),
      });
    } catch {}
  }

  return memories.sort((a, b) => a.slug.localeCompare(b.slug));
}

function updateMemoryIndex(slug, title, desc, remove = false) {
  if (!fs.existsSync(MEMORY_INDEX_FILE)) return;
  const text = fs.readFileSync(MEMORY_INDEX_FILE, 'utf8');
  const lines = text.split('\n');
  const targetPattern = new RegExp(`\\[.*?\\]\\(${slug}\\.md\\)`);

  const filtered = lines.filter(l => !targetPattern.test(l));

  if (!remove) {
    const newLine = `- [${title}](${slug}.md) - ${desc}`;
    filtered.push(newLine);
  }

  atomicWrite(MEMORY_INDEX_FILE, filtered.filter(Boolean).join('\n') + '\n');
}

function saveMemory({ slug, name, description, type, body }) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error('记忆标识 (slug) 只能包含小写字母、数字和短横线');
  }

  const validTypes = ['user', 'feedback', 'project', 'reference'];
  const finalType = validTypes.includes(type) ? type : 'reference';
  const filePath = path.join(MEMORY_DIR, `${slug}.md`);

  const fileContent = renderFrontmatter({
    name: name || slug,
    slug,
    description: description || '',
    type: finalType,
  }, body || '');

  backup(filePath);
  atomicWrite(filePath, fileContent);
  updateMemoryIndex(slug, name || slug, description || '', false);

  return { ok: true, slug };
}

function deleteMemory(slug) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error('无效的记忆标识');
  }
  const filePath = path.join(MEMORY_DIR, `${slug}.md`);
  if (fs.existsSync(filePath)) {
    backup(filePath);
    fs.unlinkSync(filePath);
  }
  updateMemoryIndex(slug, '', '', true);
  return { ok: true, slug };
}

// ----------------------------------------------------------- Rules (CLAUDE.md / AGENTS.md)
function getKnownRuleFiles() {
  const rules = [
    { id: 'global-claude', name: '全域指令 (~/.claude/CLAUDE.md)', path: path.join(HOME, '.claude', 'CLAUDE.md') },
    { id: 'workspace-claude', name: '工作区指令 (~/CLAUDE.md)', path: path.join(HOME, 'CLAUDE.md') },
    { id: 'workspace-agents', name: '工作区协作规则 (~/AGENTS.md)', path: path.join(HOME, 'AGENTS.md') },
  ];

  // Scan subprojects under HOME
  try {
    const subs = fs.readdirSync(HOME, { withFileTypes: true });
    for (const ent of subs) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const cFile = path.join(HOME, ent.name, 'CLAUDE.md');
      if (fs.existsSync(cFile)) {
        rules.push({
          id: `project-${ent.name}-claude`,
          name: `${ent.name} 专属指令 (${ent.name}/CLAUDE.md)`,
          path: cFile,
        });
      }
      const aFile = path.join(HOME, ent.name, 'AGENTS.md');
      if (fs.existsSync(aFile)) {
        rules.push({
          id: `project-${ent.name}-agents`,
          name: `${ent.name} 协作准则 (${ent.name}/AGENTS.md)`,
          path: aFile,
        });
      }
    }
  } catch {}

  return rules.filter(r => fs.existsSync(r.path));
}

function listRules() {
  return getKnownRuleFiles().map(r => ({
    id: r.id,
    name: r.name,
    path: r.path.replace(HOME, '~'),
  }));
}

function getRule(id) {
  const rules = getKnownRuleFiles();
  const found = rules.find(r => r.id === id);
  if (!found) throw new Error('未找到该规则文件');
  return {
    id: found.id,
    name: found.name,
    path: found.path.replace(HOME, '~'),
    content: fs.readFileSync(found.path, 'utf8'),
  };
}

function saveRule(id, content) {
  const rules = getKnownRuleFiles();
  const found = rules.find(r => r.id === id);
  if (!found) throw new Error('未找到该规则文件');

  backup(found.path);
  atomicWrite(found.path, content);
  return { ok: true, id: found.id };
}

module.exports = {
  listMemories,
  saveMemory,
  deleteMemory,
  listRules,
  getRule,
  saveRule,
};
