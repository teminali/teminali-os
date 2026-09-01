import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, CONTESTANTS, copyTree, hashes, writeJson } from './lib.mjs';

if (!fs.existsSync(path.join(ROOT, 'FROZEN.json'))) throw new Error('benchmark must be frozen before prepare');
for (const contestant of CONTESTANTS) {
  const destination = path.join(ROOT, 'runs', contestant);
  if (fs.existsSync(destination)) throw new Error(`refusing to overwrite existing workspace: ${destination}`);
  copyTree(path.join(ROOT, 'seed'), destination);
  writeJson(path.join(ROOT, 'state', 'baselines', `${contestant}.json`), { createdAt: new Date().toISOString(), hashes: hashes(destination) });
}
writeJson(path.join(ROOT, 'state', 'run-config.json'), {
  benchmarkId: 'frontier-auto-vs-codex-007',
  frontier: {
    contestant: 'frontier-auto-1', mode: 'Frontier Auto', maxLocked: true,
    expectedRoute: 'Frontier Flash', shippedRevision: null, permissions: null, tools: null,
  },
  codex: {
    contestant: 'codex-1', visibleModelBuild: null, reasoningEffort: null,
    serviceTier: null, permissions: null, tools: null,
  },
  runtime: { node: process.version, platform: process.platform, arch: process.arch, hostname: os.hostname() },
});
console.log('Prepared fresh isolated workspaces:');
for (const contestant of CONTESTANTS) console.log(path.join(ROOT, 'runs', contestant));
console.log(`Complete ${path.join(ROOT, 'state', 'run-config.json')} before starting either clock.`);
