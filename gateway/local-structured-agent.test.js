import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyVerificationFailure,
  collectWritableFiles,
  runStructuredLocalAgent,
  structuredOutputTokens,
  taskContractAreas,
} from "./local-structured-agent.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-structured-"));
  fs.mkdirSync(path.join(directory, "src"));
  fs.mkdirSync(path.join(directory, "test"));
  fs.writeFileSync(path.join(directory, "TASK.md"), "repair both source files");
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(directory, ".env"), "SECRET=never-read");
  fs.writeFileSync(path.join(directory, "src", "a.js"), "export const a = 0;\n");
  fs.writeFileSync(path.join(directory, "src", "b.js"), "export const b = 0;\n");
  fs.writeFileSync(path.join(directory, "test", "hidden.test.js"), "throw new Error('protected');\n");
  return directory;
}

test("collectWritableFiles includes source and excludes protected or hidden files", () => {
  const directory = fixture();
  try {
    assert.deepEqual(collectWritableFiles(directory), ["src/a.js", "src/b.js"]);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("structured output budget scales with bounded source size", () => {
  assert.equal(structuredOutputTokens("small"), 768);
  assert.equal(structuredOutputTokens("x".repeat(6_000)), 2000);
  assert.equal(structuredOutputTokens("x".repeat(20_000)), 3072);
});

test("benchmark-gap regression fixture classifies every independent repair mechanism", () => {
  const fixturePath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "fixtures",
    "structured-repair",
    "multi-contract-failures.txt",
  );
  const output = fs.readFileSync(fixturePath, "utf8");
  assert.deepEqual(classifyVerificationFailure(output).map((item) => item.id), [
    "strict-input-validation",
    "canonical-key-normalization",
    "aggregate-state-accounting",
    "idempotent-replay",
    "request-intent-conflict",
    "append-log-tail-recovery",
    "null-safe-public-api",
  ]);
});

test("task contract extraction keeps non-visible requirements in the repair checklist", () => {
  const prompt = [
    "Normalize identifiers and reject invalid quantities without coercion.",
    "Prevent aggregate overselling after reconstruction.",
    "Make commands idempotent and reject reuse of a request ID for a different intent.",
    "Recover from an incomplete final record but reject corruption elsewhere.",
    "Return a snapshot callers cannot mutate.",
  ].join(" ");
  assert.deepEqual(taskContractAreas(prompt), [
    "strict-input-validation",
    "null-safe-public-api",
    "canonical-key-normalization",
    "aggregate-state-accounting",
    "idempotent-replay",
    "request-intent-conflict",
    "append-log-tail-recovery",
    "snapshot-isolation",
  ]);
});

test("structured local agent applies bounded writes and requires verification", async () => {
  const directory = fixture();
  const requests = [];
  const events = [];
  try {
    const fetchImpl = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "one", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/a.js", content: "export const a = 1;\n" }) } },
              { id: "two", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/b.js", content: "export const b = 2;\n" }) } },
            ],
          },
        }],
      });
    };
    const result = await runStructuredLocalAgent({
      endpoint: "http://127.0.0.1:8787",
      accessToken: "test-token",
      targetDir: directory,
      prompt: "repair",
      snapshot: "bounded snapshot",
      fetchImpl,
      checkRunner: async () => ({ available: true, code: 0, output: "pass" }),
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedFiles, ["src/a.js", "src/b.js"]);
    assert.equal(fs.readFileSync(path.join(directory, "src", "a.js"), "utf8"), "export const a = 1;\n");
    assert.equal(requests[0].tool_choice, "required");
    assert.equal(requests[0].max_tokens, 768);
    assert.deepEqual(requests[0].tools[0].function.parameters.properties.path.enum, ["src/a.js", "src/b.js"]);
    assert.deepEqual(events.map((event) => event.type), [
      "model-turn",
      "file-write",
      "file-write",
      "verification-start",
      "verification-complete",
    ]);
    assert.equal(events[1].path, "src/a.js");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("structured local agent accepts bounded fenced JSON writes from local models", async () => {
  const directory = fixture();
  try {
    const result = await runStructuredLocalAgent({
      endpoint: "http://127.0.0.1:8787",
      accessToken: "test-token",
      targetDir: directory,
      prompt: "repair",
      snapshot: "bounded snapshot",
      allowedFilePaths: ["src/a.js", "src/b.js"],
      requiredFilePaths: ["src/a.js", "src/b.js"],
      fetchImpl: async () => Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: [
              "```json",
              JSON.stringify({ name: "write_file", arguments: { path: "src/a.js", content: "export const a = 1;\n" } }),
              "```",
              "```json",
              JSON.stringify({ name: "write_file", arguments: { path: "src/b.js", content: "export const b = 2;\n" } }),
              "```",
            ].join("\n"),
          },
        }],
      }),
      checkRunner: async () => ({ available: true, code: 0, output: "pass" }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedFiles, ["src/a.js", "src/b.js"]);
    assert.equal(fs.readFileSync(path.join(directory, "src", "a.js"), "utf8"), "export const a = 1;\n");
    assert.equal(fs.readFileSync(path.join(directory, "src", "b.js"), "utf8"), "export const b = 2;\n");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("prompt-json transport omits native tools and accepts strict whole-response JSON", async () => {
  const directory = fixture();
  let request;
  try {
    const result = await runStructuredLocalAgent({
      endpoint: "http://127.0.0.1:8787",
      accessToken: "test-token",
      targetDir: directory,
      prompt: "repair",
      snapshot: "bounded snapshot",
      allowedFilePaths: ["src/a.js", "src/b.js"],
      requiredFilePaths: ["src/a.js", "src/b.js"],
      toolTransport: "prompt-json",
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: JSON.stringify([
                { name: "write_file", arguments: { path: "src/a.js", content: "export const a = 1;\n" } },
                { name: "write_file", arguments: { path: "src/b.js", content: "export const b = 2;\n" } },
              ]),
            },
          }],
        });
      },
      checkRunner: async () => ({ available: true, code: 0, output: "pass" }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedFiles, ["src/a.js", "src/b.js"]);
    assert.equal(request.tools, undefined);
    assert.equal(request.tool_choice, undefined);
    assert.ok(request.max_tokens >= 1024);
    assert.match(request.messages.at(-1).content, /Return only a JSON object or JSON array/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("structured local agent rejects unknown tool transports", async () => {
  const directory = fixture();
  try {
    const result = await runStructuredLocalAgent({
      endpoint: "http://127.0.0.1:8787",
      accessToken: "test-token",
      targetDir: directory,
      prompt: "repair",
      snapshot: "bounded snapshot",
      toolTransport: "guess",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_tool_transport");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("structured local agent rejects a write outside the bounded source set", async () => {
  const directory = fixture();
  try {
    const result = await runStructuredLocalAgent({
      endpoint: "http://127.0.0.1:8787",
      accessToken: "test-token",
      targetDir: directory,
      prompt: "repair",
      snapshot: "bounded snapshot",
      fetchImpl: async () => Response.json({
        choices: [{ message: { role: "assistant", tool_calls: [{ id: "bad", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "test/hidden.test.js", content: "changed" }) } }] } }],
      }),
      checkRunner: async () => ({ available: true, code: 0, output: "pass" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "structured_disallowed_write");
    assert.match(fs.readFileSync(path.join(directory, "test", "hidden.test.js"), "utf8"), /protected/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("structured local agent honors an explicit per-run file allowlist", async () => {
  const directory = fixture();
  let exposedPaths;
  try {
    const result = await runStructuredLocalAgent({
      endpoint: "http://127.0.0.1:8787",
      accessToken: "test-token",
      targetDir: directory,
      prompt: "repair",
      snapshot: "bounded snapshot",
      allowedFilePaths: ["src/a.js"],
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        exposedPaths = request.tools[0].function.parameters.properties.path.enum;
        return Response.json({
          choices: [{ message: { role: "assistant", tool_calls: [{ id: "one", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/a.js", content: "export const a = 1;\n" }) } }] } }],
        });
      },
      checkRunner: async () => ({ available: true, code: 0, output: "pass" }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(exposedPaths, ["src/a.js"]);
    assert.match(fs.readFileSync(path.join(directory, "src", "b.js"), "utf8"), /b = 0/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("structured local agent continues after passing tests until required files are written", async () => {
  const directory = fixture();
  let call = 0;
  const exposedPaths = [];
  try {
    const result = await runStructuredLocalAgent({
      endpoint: "http://127.0.0.1:8787",
      accessToken: "test-token",
      targetDir: directory,
      prompt: "repair",
      snapshot: "bounded snapshot",
      allowedFilePaths: ["src/a.js", "src/b.js"],
      requiredFilePaths: ["src/a.js", "src/b.js"],
      fetchImpl: async (_url, options) => {
        call += 1;
        const request = JSON.parse(options.body);
        exposedPaths.push(request.tools[0].function.parameters.properties.path.enum);
        const file = call === 1 ? "src/a.js" : "src/b.js";
        return Response.json({
          choices: [{ message: { role: "assistant", tool_calls: [{ id: `call-${call}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: file, content: `export const value = ${call};\n` }) } }] } }],
        });
      },
      checkRunner: async () => ({ available: true, code: 0, output: "pass" }),
    });
    assert.equal(result.ok, true);
    assert.equal(call, 2);
    assert.deepEqual(result.changedFiles, ["src/a.js", "src/b.js"]);
    assert.deepEqual(exposedPaths, [["src/a.js", "src/b.js"], ["src/b.js"]]);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("failed verification gets a bounded classified repair turn with fresh current files", async () => {
  const directory = fixture();
  const requests = [];
  const events = [];
  let modelTurn = 0;
  let checkTurn = 0;
  try {
    const result = await runStructuredLocalAgent({
      endpoint: "http://127.0.0.1:8787",
      accessToken: "test-token",
      targetDir: directory,
      prompt: [
        "Normalize keys, reject invalid quantities without coercion, and prevent aggregate overselling.",
        "Commands must be idempotent and reject reuse for a different intent.",
        "Recover an incomplete final record while rejecting corruption elsewhere.",
      ].join(" "),
      snapshot: "--- test/visible.test.js ---\nassert aggregate capacity and duplicate replay\n",
      allowedFilePaths: ["src/a.js", "src/b.js"],
      requiredFilePaths: ["src/a.js", "src/b.js"],
      fetchImpl: async (_url, options) => {
        modelTurn += 1;
        const request = JSON.parse(options.body);
        requests.push(request);
        const content = modelTurn === 1
          ? "export const implementation = 'partial-v1';\n"
          : "export const implementation = 'repaired-v2';\n";
        return Response.json({
          choices: [{ message: {
            role: "assistant",
            content: null,
            tool_calls: request.tools[0].function.parameters.properties.path.enum.map((file, index) => ({
              id: `turn-${modelTurn}-${index}`,
              type: "function",
              function: { name: "write_file", arguments: JSON.stringify({ path: file, content }) },
            })),
          } }],
        });
      },
      checkRunner: async () => {
        checkTurn += 1;
        return checkTurn === 1
          ? {
              available: true,
              code: 1,
              output: [
                "prevents aggregate overselling: Missing expected InsufficientStockError",
                "same request must be idempotent and charged once",
              ].join("\n"),
            }
          : { available: true, code: 0, output: "pass" };
      },
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(result.repairAttempts, 1);
    assert.deepEqual(result.verificationCategories, [
      "aggregate-state-accounting",
      "idempotent-replay",
    ]);
    assert.equal(requests.length, 2);
    const repairPrompt = requests[1].messages.find((message) => message.role === "user").content;
    assert.match(repairPrompt, /partial-v1/);
    assert.doesNotMatch(repairPrompt, /tool_calls/);
    assert.match(repairPrompt, /Classified failure areas: aggregate-state-accounting, idempotent-replay/);
    assert.match(repairPrompt, /request-intent-conflict/);
    assert.match(repairPrompt, /append-log-tail-recovery/);
    assert.match(repairPrompt, /null-safe-public-api/);
    assert.equal(events.filter((event) => event.type === "verification-classified").length, 1);
    assert.match(fs.readFileSync(path.join(directory, "src", "a.js"), "utf8"), /repaired-v2/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("structured local agent cancels an in-flight request promptly", async () => {
  const directory = fixture();
  const controller = new AbortController();
  const events = [];
  try {
    const pending = runStructuredLocalAgent({
      endpoint: "http://127.0.0.1:8787",
      accessToken: "test-token",
      targetDir: directory,
      prompt: "repair",
      snapshot: "bounded snapshot",
      signal: controller.signal,
      onEvent: (event) => events.push(event),
      fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(options.signal.reason ?? new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    });
    controller.abort();
    const result = await pending;
    assert.equal(result.code, 130);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "structured_run_cancelled");
    assert.equal(events.at(-1).type, "cancelled");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
