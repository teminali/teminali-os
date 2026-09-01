import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sha256, walk, writeJson } from './lib.mjs';

const excluded = new Set(['MANIFEST.sha256', 'FROZEN.json']);
const entries = walk(ROOT).filter((item) => item.type === 'file').map((item) => {
  const relative = path.relative(ROOT, item.path).split(path.sep).join('/');
  return { relative, file: item.path };
}).filter(({ relative }) => !excluded.has(relative) && !relative.startsWith('runs/') && !relative.startsWith('state/') && !relative.startsWith('results/')).sort((a, b) => a.relative.localeCompare(b.relative));
const manifest = `${entries.map(({ relative, file }) => `${sha256(file)}  ${relative}`).join('\n')}\n`;
fs.writeFileSync(path.join(ROOT, 'MANIFEST.sha256'), manifest, 'utf8');
writeJson(path.join(ROOT, 'FROZEN.json'), {
  benchmarkId: 'frontier-auto-vs-codex-006', frozenAtUtc: new Date().toISOString(),
  manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex'), fileCount: entries.length,
  immutableScopes: ['seed/', 'reference/', '.control/', 'TASK.md', 'RUBRIC.md', 'PREREGISTRATION.json', 'VALIDATION.json'],
  mutableScopes: ['runs/', 'state/', 'results/'],
});
console.log(`Frozen ${entries.length} files; manifest sha256 ${crypto.createHash('sha256').update(manifest).digest('hex')}`);
