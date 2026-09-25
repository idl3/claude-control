/**
 * Disk records for ACP sessions: ~/.claude-control/acp/<id>/{meta.json,history.jsonl}
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../json-file.js';

export function sessionDir(dataDir, id) {
  return path.join(dataDir, 'acp', String(id));
}

export async function writeMeta(dataDir, id, meta) {
  const dir = sessionDir(dataDir, id);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
}

export async function writeHistory(dataDir, id, messages) {
  const dir = sessionDir(dataDir, id);
  await fs.mkdir(dir, { recursive: true });
  const body = (messages || []).map((m) => JSON.stringify(m)).join('\n');
  await fs.writeFile(path.join(dir, 'history.jsonl'), body ? body + '\n' : '', 'utf8');
}

export async function readHistory(dataDir, id) {
  const file = path.join(sessionDir(dataDir, id), 'history.jsonl');
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out;
}

export async function removeSession(dataDir, id) {
  await fs.rm(sessionDir(dataDir, id), { recursive: true, force: true });
}

export async function listMetas(dataDir) {
  const root = path.join(dataDir, 'acp');
  let names;
  try {
    names = await fs.readdir(root);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    try {
      const raw = await fs.readFile(path.join(root, name, 'meta.json'), 'utf8');
      out.push(JSON.parse(raw));
    } catch {
      /* skip */
    }
  }
  return out;
}
