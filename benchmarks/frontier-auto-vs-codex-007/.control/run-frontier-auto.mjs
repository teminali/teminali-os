import fs from 'node:fs';
import path from 'node:path';
import { ROOT, copyTree } from './lib.mjs';
import { runStructuredLocalAgent } from '../../../gateway/local-structured-agent.js';
import { spawnSync } from 'node:child_process';

const CONTESTANT = 'frontier-auto-1';
const WORKSPACE = path.join(ROOT, 'runs', CONTESTANT);
const SEED_DIR = path.join(ROOT, 'seed');
const TASK_FILE = path.join(ROOT, 'TASK.md');
const MODEL_NAME = 'frontier-qwen2.5-coder-14b-8k';

async function checkOllamaResidency() {
  const res = await fetch('http://127.0.0.1:11434/api/ps');
  const data = await res.json();
  const active = (data.models || []).filter(m => !m.expires_at || new Date(m.expires_at) > new Date());
  return active.length;
}

async function unloadModel() {
  await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_NAME, keep_alive: 0 }),
  }).catch(() => {});
}

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

  const initialResident = await checkOllamaResidency();
  if (initialResident > 0) {
    console.log('Unloading existing resident models before benchmark...');
    await unloadModel();
  }

  // 1. Capture Before Evidence
  spawnSync(process.execPath, [path.join(ROOT, '.control', 'evidence.mjs'), 'before', CONTESTANT], { stdio: 'inherit' });

  // 2. Start Monotonic Clock
  spawnSync(process.execPath, [path.join(ROOT, '.control', 'clock.mjs'), 'start', CONTESTANT], { stdio: 'inherit' });

  const taskPrompt = fs.readFileSync(TASK_FILE, 'utf8');

  // Streaming fetch adapter to prevent HTTP socket headers timeout on large local generations
  const fetchImpl = async (url, options) => {
    const parsedBody = JSON.parse(options.body);
    parsedBody.model = MODEL_NAME;
    parsedBody.stream = true;

    const res = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsedBody),
      signal: options.signal,
    });

    if (!res.ok) return res;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedContent = '';
    const toolCalls = [];
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const chunk = JSON.parse(dataStr);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            accumulatedContent += delta.content;
            process.stdout.write('.');
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? toolCalls.length;
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: tc.id || `call_${idx}`,
                  type: 'function',
                  function: { name: tc.function?.name || '', arguments: '' },
                };
              }
              if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch {}
      }
    }
    process.stdout.write('\n');

    const responsePayload = {
      choices: [{
        message: {
          role: 'assistant',
          content: accumulatedContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      }],
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    console.log(`Executing structured local agent in ${WORKSPACE}...`);
    const startTime = Date.now();

    const outcome = await runStructuredLocalAgent({
      endpoint: 'http://127.0.0.1:11434',
      accessToken: 'ollama-local',
      targetDir: WORKSPACE,
      prompt: `Repair src/token-bucket.js, src/circuit-breaker.js, and src/gatekeeper.js to satisfy the task contracts and visible tests.\n\n${taskPrompt}`,
      snapshot: fs.readFileSync(path.join(WORKSPACE, 'TASK.md'), 'utf8'),
      allowedFilePaths: ['src/token-bucket.js', 'src/circuit-breaker.js', 'src/gatekeeper.js'],
      requiredFilePaths: ['src/token-bucket.js', 'src/circuit-breaker.js', 'src/gatekeeper.js'],
      fetchImpl,
      toolTransport: 'native',
      maxTurns: 4,
      requestTimeoutMs: 600_000,
      onEvent: (event) => {
        console.log(`\n[Event: ${event.type}]`, JSON.stringify(event));
      },
    });

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\nAgent finished in ${elapsedSec}s with outcome:`, JSON.stringify(outcome, null, 2));
  } catch (err) {
    console.error('Agent execution threw error:', err);
  } finally {
    // 3. Unload Model
    await unloadModel();

    // 4. Stop Monotonic Clock
    spawnSync(process.execPath, [path.join(ROOT, '.control', 'clock.mjs'), 'stop', CONTESTANT], { stdio: 'inherit' });

    // 5. Capture After Evidence
    spawnSync(process.execPath, [path.join(ROOT, '.control', 'evidence.mjs'), 'after', CONTESTANT], { stdio: 'inherit' });
  }

  // 6. Run Official Scorer
  console.log(`\n=== SCORING RUN: ${CONTESTANT} ===`);
  const scoreResult = spawnSync(process.execPath, [path.join(ROOT, '.control', 'score.mjs'), CONTESTANT], { stdio: 'inherit' });

  const finalResident = await checkOllamaResidency();
  console.log(`Final Ollama residency count: ${finalResident}`);

  if (scoreResult.status !== 0) {
    console.error(`Scoring failed with exit code ${scoreResult.status}`);
    process.exitCode = 1;
  } else {
    console.log(`\n*** BENCHMARK 007 RUN FOR ${CONTESTANT} COMPLETE ***\n`);
  }
}

main().catch((err) => {
  console.error('Benchmark execution error:', err);
  process.exitCode = 1;
});
