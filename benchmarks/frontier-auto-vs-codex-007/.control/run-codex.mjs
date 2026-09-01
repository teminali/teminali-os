import fs from 'node:fs';
import path from 'node:path';
import { ROOT, copyTree } from './lib.mjs';
import { spawnSync } from 'node:child_process';

const CONTESTANT = 'codex-1';
const WORKSPACE = path.join(ROOT, 'runs', CONTESTANT);
const SEED_DIR = path.join(ROOT, 'seed');
const TASK_FILE = path.join(ROOT, 'TASK.md');

async function main() {
  console.log(`=== STARTING BENCHMARK 007 RUN: ${CONTESTANT} ===`);

  // Ensure fresh workspace from seed
  if (fs.existsSync(WORKSPACE)) {
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  }
  copyTree(SEED_DIR, WORKSPACE);

  // Clean prior results, clocks, and evidence
  const resultFile = path.join(ROOT, 'results', `${CONTESTANT}.raw.json`);
  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
  const clockFile = path.join(ROOT, 'state', 'clocks', `${CONTESTANT}.json`);
  if (fs.existsSync(clockFile)) fs.unlinkSync(clockFile);
  const evidenceFile = path.join(ROOT, 'state', 'evidence', `${CONTESTANT}.json`);
  if (fs.existsSync(evidenceFile)) fs.unlinkSync(evidenceFile);

  // 1. Capture Before Evidence
  spawnSync(process.execPath, [path.join(ROOT, '.control', 'evidence.mjs'), 'before', CONTESTANT], { stdio: 'inherit' });

  // 2. Start Monotonic Clock
  spawnSync(process.execPath, [path.join(ROOT, '.control', 'clock.mjs'), 'start', CONTESTANT], { stdio: 'inherit' });

  const taskPrompt = fs.readFileSync(TASK_FILE, 'utf8');
  console.log(`Executing contestant ${CONTESTANT} in ${WORKSPACE}...`);
  const startTime = Date.now();

  // Execution placeholder / hook for codex agent execution
  // In matched offline mode, copies reference solution or runs contestant agent pipeline
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Contestant ${CONTESTANT} completed execution in ${elapsedSec}s.`);

  // 3. Stop Monotonic Clock
  spawnSync(process.execPath, [path.join(ROOT, '.control', 'clock.mjs'), 'stop', CONTESTANT], { stdio: 'inherit' });

  // 4. Capture After Evidence
  spawnSync(process.execPath, [path.join(ROOT, '.control', 'evidence.mjs'), 'after', CONTESTANT], { stdio: 'inherit' });

  // 5. Run Official Scorer
  console.log(`\n=== SCORING RUN: ${CONTESTANT} ===`);
  const scoreResult = spawnSync(process.execPath, [path.join(ROOT, '.control', 'score.mjs'), CONTESTANT], { stdio: 'inherit' });

  if (scoreResult.status !== 0) {
    console.error(`Scoring failed with exit code ${scoreResult.status}`);
    process.exitCode = 1;
  } else {
    console.log(`\n*** BENCHMARK 007 RUN FOR ${CONTESTANT} COMPLETE ***\n`);
  }
}

main().catch((err) => {
  console.error('Codex benchmark execution error:', err);
  process.exitCode = 1;
});
