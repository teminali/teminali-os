import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const CONTESTANTS = ['frontier-auto-1', 'codex-1'];
export const LIMIT_NS = 2_700_000_000_000n;

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function walk(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) output.push({ path: full, type: 'symlink' });
    else if (entry.isDirectory()) output.push(...walk(full));
    else if (entry.isFile()) output.push({ path: full, type: 'file' });
  }
  return output;
}

export function hashes(root) {
  return Object.fromEntries(walk(root).filter((item) => item.type === 'file').map((item) => [
    path.relative(root, item.path).split(path.sep).join('/'), sha256(item.path),
  ]).sort(([a], [b]) => a.localeCompare(b)));
}

export function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const item of walk(source)) {
    const relative = path.relative(source, item.path);
    const target = path.join(destination, relative);
    if (item.type === 'symlink') throw new Error(`fixture symlink forbidden: ${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(item.path, target, fs.constants.COPYFILE_EXCL);
  }
}

export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function requireContestant(value) {
  if (!CONTESTANTS.includes(value)) throw new Error(`contestant must be one of: ${CONTESTANTS.join(', ')}`);
  return value;
}

export function allowed(relative) {
  return relative.startsWith('src/') && relative.endsWith('.js') && !relative.includes('..');
}

export function workspaceIntegrity(contestant) {
  const workspace = path.join(ROOT, 'runs', contestant);
  const baselineFile = path.join(ROOT, 'state', 'baselines', `${contestant}.json`);
  if (!fs.existsSync(workspace) || !fs.existsSync(baselineFile)) return { ok: false, reason: 'workspace not prepared' };
  const baseline = readJson(baselineFile).hashes;
  const current = hashes(workspace);
  const paths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const forbiddenChanges = [...paths].filter((relative) => baseline[relative] !== current[relative] && !allowed(relative)).sort();
  const symlinks = walk(workspace).filter((item) => item.type === 'symlink').map((item) => path.relative(workspace, item.path));
  return { ok: forbiddenChanges.length === 0 && symlinks.length === 0, forbiddenChanges, symlinks };
}
