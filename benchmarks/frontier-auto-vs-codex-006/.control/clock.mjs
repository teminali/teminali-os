import fs from 'node:fs';
import path from 'node:path';
import { ROOT, LIMIT_NS, readJson, requireContestant, writeJson } from './lib.mjs';

const action = process.argv[2];
const contestant = requireContestant(process.argv[3]);
const file = path.join(ROOT, 'state', 'clocks', `${contestant}.json`);
const config = readJson(path.join(ROOT, 'state', 'run-config.json'));
const side = contestant === 'frontier-auto-1' ? config.frontier : config.codex;
const required = contestant === 'frontier-auto-1' ? ['shippedRevision', 'permissions', 'tools'] : ['visibleModelBuild', 'reasoningEffort', 'serviceTier', 'permissions', 'tools'];

if (action === 'start') {
  if (fs.existsSync(file)) throw new Error(`clock state already exists for ${contestant}`);
  if (!required.every((key) => side?.[key] !== null && side?.[key] !== '' && (!Array.isArray(side?.[key]) || side[key].length))) {
    throw new Error('run-config identity/tools/permissions must be completed before clock start');
  }
  if (config.runtime.node !== process.version) throw new Error(`Node runtime changed: expected ${config.runtime.node}, got ${process.version}`);
  const start = process.hrtime.bigint();
  writeJson(file, { contestant, startWallUtc: new Date().toISOString(), startMonotonicNs: start.toString(), limitNs: LIMIT_NS.toString() });
  console.log(`Started ${contestant} at monotonic ${start}`);
} else if (action === 'stop') {
  if (!fs.existsSync(file)) throw new Error(`clock not started for ${contestant}`);
  const clock = readJson(file);
  if (clock.stopMonotonicNs) throw new Error(`clock already stopped for ${contestant}`);
  const stop = process.hrtime.bigint();
  const elapsed = stop - BigInt(clock.startMonotonicNs);
  writeJson(file, { ...clock, stopWallUtc: new Date().toISOString(), stopMonotonicNs: stop.toString(), elapsedNs: elapsed.toString(), elapsedSeconds: Number(elapsed) / 1e9, exceededLimit: elapsed > LIMIT_NS });
  console.log(`Stopped ${contestant}: ${(Number(elapsed) / 1e9).toFixed(3)} seconds`);
} else throw new Error('usage: node .control/clock.mjs <start|stop> <frontier-auto-1|codex-1>');
