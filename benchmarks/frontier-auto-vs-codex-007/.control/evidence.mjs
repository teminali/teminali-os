import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson, requireContestant, writeJson } from './lib.mjs';

const phase = process.argv[2];
const contestant = requireContestant(process.argv[3]);
if (!['before', 'after'].includes(phase)) throw new Error('phase must be before or after');
const file = path.join(ROOT, 'state', 'evidence', `${contestant}.json`);
let prior = {};
try { prior = readJson(file); } catch {}
prior[phase] = {
  wallUtc: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(),
  host: { platform: process.platform, arch: process.arch, node: process.version, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), loadAverage: os.loadavg() },
  modelResidency: { status: null, evidenceSource: null, note: 'Operator must record local model residency or explicit none.' },
  routeEvidence: { selectedMode: null, observedRoute: null, note: 'Record visible product tier only; do not place credentials here.' },
};
writeJson(file, prior);
console.log(`Captured ${phase} resource snapshot. Complete evidence slots in ${file}.`);
