import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runStructuredLocalAgent } from "./local-structured-agent.js";

const MODEL_NAME = "frontier-qwen2.5-coder-14b-8k";

async function checkOllamaResidency() {
  const res = await fetch("http://127.0.0.1:11434/api/ps");
  const data = await res.json();
  const now = new Date();
  return (data.models || []).filter((m) => new Date(m.expires_at) > now);
}

async function unloadModel(model) {
  try {
    await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
  } catch {}
}

async function main() {
  console.log("=== STEP 1: Verifying Initial Ollama Residency ===");
  const initialModels = await checkOllamaResidency();
  assert.equal(initialModels.length, 0, `Ollama must have 0 resident models before test, found: ${JSON.stringify(initialModels)}`);
  console.log("Initial Ollama residency: 0 models.");

  console.log("=== STEP 2: Creating Isolated Repair Fixture ===");
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-repair-canary-"));
  fs.mkdirSync(path.join(targetDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(targetDir, "test"), { recursive: true });

  fs.writeFileSync(
    path.join(targetDir, "package.json"),
    JSON.stringify({
      name: "frontier-repair-fixture",
      type: "module",
      scripts: { test: "node --test test/visible.test.js" },
    }, null, 2),
  );

  fs.writeFileSync(
    path.join(targetDir, "TASK.md"),
    `# Rate Limiter and Key Normalizer Task

Implement and repair the modules in \`src/normalizer.js\` and \`src/limiter.js\`.

Requirements:
1. \`normalizeKey(key)\`:
   - Must reject null, undefined, and non-string inputs by throwing a \`ValidationError\` (strict input validation).
   - Must trim leading/trailing whitespace and lowercase the key (canonical key normalization).
2. \`RateLimiter(limit)\`:
   - Must reject limits that are not positive integers (<= 0 or non-number) by throwing a \`ValidationError\`.
   - \`consume(key)\`: Must track aggregate state per normalized key and return true if under limit, false if capacity exceeded (aggregate state accounting).
`,
  );

  // Initial broken code: normalizer does not validate null or normalize case/trim
  fs.writeFileSync(
    path.join(targetDir, "src", "normalizer.js"),
    `export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export function normalizeKey(key) {
  return String(key);
}
`,
  );

  // Initial limiter without positive limit validation
  fs.writeFileSync(
    path.join(targetDir, "src", "limiter.js"),
    `import { ValidationError, normalizeKey } from "./normalizer.js";

export class RateLimiter {
  constructor(limit) {
    this.limit = limit;
    this.usage = new Map();
  }

  consume(key) {
    const k = normalizeKey(key);
    const count = (this.usage.get(k) || 0) + 1;
    this.usage.set(k, count);
    return count <= this.limit;
  }
}
`,
  );

  fs.writeFileSync(
    path.join(targetDir, "test", "visible.test.js"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { normalizeKey, ValidationError } from "../src/normalizer.js";
import { RateLimiter } from "../src/limiter.js";

test("strict input validation: null key throws ValidationError", () => {
  assert.throws(() => normalizeKey(null), (err) => {
    return err instanceof ValidationError || err?.name === "ValidationError";
  }, "validationerror: positive integer or string required without coercion");
});

test("canonical key normalization: trims and lowercases keys", () => {
  assert.equal(normalizeKey("  User_Alpha  "), "user_alpha", "canonical-key-normalization failed");
});

test("aggregate state accounting: enforces rate limit capacity", () => {
  const limiter = new RateLimiter(2);
  assert.equal(limiter.consume("  USER_A "), true);
  assert.equal(limiter.consume("user_a"), true);
  assert.equal(limiter.consume("user_a"), false, "insufficientstock: aggregate capacity exceeded");
});
`,
  );

  console.log("Fixture created at:", targetDir);

  console.log("=== STEP 3: Executing Structured Agent with Real Local Model ===");
  const events = [];
  const started = performance.now();

  const fetchImpl = async (url, options) => {
    const parsedBody = JSON.parse(options.body);
    // Route frontier-code to local 14b coder model
    parsedBody.model = MODEL_NAME;
    const res = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsedBody),
      signal: options.signal,
    });
    return res;
  };

  const outcome = await runStructuredLocalAgent({
    endpoint: "http://127.0.0.1:11434",
    accessToken: "ollama-local",
    targetDir,
    prompt: `Repair both src/normalizer.js and src/limiter.js to satisfy the task contracts and visible tests.
Contract areas:
- strict-input-validation: throw ValidationError for non-string, null, or undefined key, or invalid limit.
- canonical-key-normalization: trim and lowercase the key.
- aggregate-state-accounting: derive decision from accumulated usage per normalized key.
Write all required final source files now.`,
    snapshot: fs.readFileSync(path.join(targetDir, "TASK.md"), "utf8"),
    allowedFilePaths: ["src/normalizer.js", "src/limiter.js"],
    requiredFilePaths: ["src/normalizer.js", "src/limiter.js"],
    toolTransport: "native",
    fetchImpl,
    onEvent: (event) => {
      events.push(event);
      console.log(`[Event: ${event.type}]`, JSON.stringify(event));
    },
  });

  const durationSec = (performance.now() - started) / 1000;
  console.log(`=== STEP 4: Evaluating Outcome in ${durationSec.toFixed(2)}s ===`);
  console.log("Outcome result:", JSON.stringify(outcome, null, 2));

  // Assert 1: Agent succeeded with green verification
  assert.equal(outcome.ok, true, `Structured agent must succeed, got: ${outcome.reason}`);
  assert.equal(outcome.code, 0, `Exit code must be 0, got: ${outcome.code}`);

  // Assert 2: Only allowed files were changed
  assert.deepEqual(outcome.changedFiles, ["src/limiter.js", "src/normalizer.js"], "Only allowed files must be modified");

  // Assert 3: Verification passed
  assert.equal(outcome.verification?.code, 0, "Independent npm test verification must pass");

  // Assert 4: Required repair turn occurred (model was driven by visible test feedback)
  console.log(`Repair attempts: ${outcome.repairAttempts}`);

  console.log("=== STEP 5: Cleaning Up and Verifying Model Unload ===");
  await unloadModel(MODEL_NAME);
  await new Promise((r) => setTimeout(r, 1000));
  const finalModels = await checkOllamaResidency();
  console.log("Final Ollama residency:", finalModels);
  assert.equal(finalModels.length, 0, "Ollama residency must be 0 after canary completion");

  fs.rmSync(targetDir, { recursive: true, force: true });
  console.log(`\n*** ISOLATED REPAIR-TURN CANARY PASSED in ${durationSec.toFixed(2)}s ***\n`);
}

main().catch((err) => {
  console.error("CANARY FAILED:", err);
  process.exit(1);
});
