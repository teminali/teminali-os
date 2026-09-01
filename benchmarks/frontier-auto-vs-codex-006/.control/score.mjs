import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, requireContestant, writeJson } from './lib.mjs';
import { eligibility } from './eligibility.mjs';
import { evaluate } from './oracle/evaluate.mjs';

const contestant = requireContestant(process.argv[2]);
const gate = eligibility(contestant);
if (!gate.eligible) {
  console.error(JSON.stringify(gate, null, 2));
  throw new Error('ineligible run: scoring refused');
}
const workspace = path.join(ROOT, 'runs', contestant);
const visibleStarted = process.hrtime.bigint();
const visible = spawnSync(process.execPath, ['--test', 'test/reservation.test.js'], { cwd: workspace, encoding: 'utf8', timeout: 120_000 });
const visibleElapsedNs = process.hrtime.bigint() - visibleStarted;
const hiddenStarted = process.hrtime.bigint();
const hidden = await evaluate(workspace);
const hiddenElapsedNs = process.hrtime.bigint() - hiddenStarted;
const raw = {
  schemaVersion: 1, benchmarkId: 'frontier-auto-vs-codex-006', contestant,
  eligible: true, scoredAtUtc: new Date().toISOString(),
  score: hidden.score, maxScore: hidden.maxScore,
  timing: { contestantElapsedNs: gate.clock.elapsedNs, visibleElapsedNs: visibleElapsedNs.toString(), hiddenElapsedNs: hiddenElapsedNs.toString() },
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  integrity: gate.integrity,
  visible: { passed: visible.status === 0, exitCode: visible.status, signal: visible.signal, stdout: visible.stdout, stderr: visible.stderr },
  privateEvaluation: hidden,
};
const output = path.join(ROOT, 'results', `${contestant}.raw.json`);
if (fs.existsSync(output)) throw new Error(`refusing to overwrite result: ${output}`);
writeJson(output, raw);
console.log(JSON.stringify({ contestant, eligible: true, score: raw.score, maxScore: raw.maxScore, result: output }, null, 2));
