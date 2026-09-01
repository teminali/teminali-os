import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, copyTree, hashes, writeJson } from './lib.mjs';
import { evaluate } from './oracle/evaluate.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-007-validation-'));
const seedCopy = path.join(temp, 'seed');
const referenceCopy = path.join(temp, 'reference');

copyTree(path.join(ROOT, 'seed'), seedCopy);
copyTree(path.join(ROOT, 'seed'), referenceCopy);

for (const [relative] of Object.entries(hashes(path.join(ROOT, 'reference')))) {
  fs.copyFileSync(path.join(ROOT, 'reference', relative), path.join(referenceCopy, relative));
}

const seedBefore = hashes(seedCopy);
const baseline = spawnSync(process.execPath, ['--test', 'test/visible.test.js'], { cwd: seedCopy, encoding: 'utf8' });
const seedAfter = hashes(seedCopy);

const baselineOracle = await evaluate(seedCopy);
const referenceVisible = spawnSync(process.execPath, ['--test', 'test/visible.test.js'], { cwd: referenceCopy, encoding: 'utf8' });
const referenceOracle = await evaluate(referenceCopy);

const baselinePassCount = (baseline.stdout.match(/(?:#|ℹ) pass\s+(\d+)/)?.[1]) || null;
const baselineFailCount = (baseline.stdout.match(/(?:#|ℹ) fail\s+(\d+)/)?.[1]) || null;

const report = {
  schemaVersion: 1,
  validatedAtUtc: new Date().toISOString(),
  node: process.version,
  fixtureIntegrity: {
    unchangedByVisibleTests: JSON.stringify(seedBefore) === JSON.stringify(seedAfter),
    files: Object.keys(seedBefore).length,
  },
  baseline: {
    visibleExit: baseline.status,
    visiblePassCount: baselinePassCount,
    visibleFailCount: baselineFailCount,
    privateScore: baselineOracle.score,
    privateMax: baselineOracle.maxScore,
  },
  reference: {
    visibleExit: referenceVisible.status,
    privateScore: referenceOracle.score,
    privateMax: referenceOracle.maxScore,
  },
  discrimination: {
    baselineBelowPerfect: baselineOracle.score < 100,
    referencePerfect: referenceOracle.score === 100,
    scoreGap: referenceOracle.score - baselineOracle.score,
  },
};

const green = report.fixtureIntegrity.unchangedByVisibleTests &&
  baseline.status !== 0 &&
  Number(baselinePassCount) > 0 &&
  Number(baselineFailCount) > 0 &&
  referenceVisible.status === 0 &&
  referenceOracle.score === 100 &&
  baselineOracle.score < 100;

report.green = green;
writeJson(path.join(ROOT, 'VALIDATION.json'), report);
console.log(JSON.stringify(report, null, 2));

if (!green) {
  console.error("Validation failed to meet green benchmark criteria!");
  process.exitCode = 1;
}
