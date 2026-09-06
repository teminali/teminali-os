import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFrontierEnvironment,
  assertLocalProfileCapacity,
  ensureLocalProfileModel,
  unloadLocalProfileModel,
  parseCliArgs,
  PROFILES,
  findOpenCodeBinary,
  listAvailableSkills,
  loadSkillContent,
  workspaceDigest,
  workspaceTextSnapshot,
  availableMemoryBytes,
  MODEL_MODES,
  modelTaskComplexity,
  runOpenCode,
  selectProfileForMode,
} from "./frontier-runner.js";

test("availableMemoryBytes uses macOS memory pressure instead of unused-page memory", () => {
  const totalMemoryBytes = 24 * 1024 ** 3;
  const available = availableMemoryBytes({
    platform: "darwin",
    totalMemoryBytes,
    freeMemoryBytes: 2 * 1024 ** 3,
    spawnSyncImpl: () => ({ stdout: "System-wide memory free percentage: 75%\n" }),
  });
  assert.equal(available, 18 * 1024 ** 3);
});

test("availableMemoryBytes keeps the portable fallback when pressure data is unavailable", () => {
  assert.equal(availableMemoryBytes({
    platform: "darwin",
    totalMemoryBytes: 24 * 1024 ** 3,
    freeMemoryBytes: 3 * 1024 ** 3,
    spawnSyncImpl: () => ({ stdout: "unavailable" }),
  }), 3 * 1024 ** 3);
  assert.equal(availableMemoryBytes({
    platform: "linux",
    freeMemoryBytes: 4 * 1024 ** 3,
  }), 4 * 1024 ** 3);
});

test("parseCliArgs parses default chat command", () => {
  const parsed = parseCliArgs([]);
  assert.equal(parsed.command, "chat");
  assert.equal(parsed.profile, "local");
  assert.equal(parsed.budget, "0.20");
});

test("parseCliArgs parses run command with prompt and options", () => {
  const parsed = parseCliArgs(["run", "build website", "-s", "website-builder", "-p", "auto", "-b", "0.50", "-v"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.prompt, "build website");
  assert.equal(parsed.skill, "website-builder");
  assert.equal(parsed.profile, "auto");
  assert.equal(parsed.budget, "0.50");
  assert.equal(parsed.verbose, true);
});

test("parseCliArgs accepts the three user-facing model modes", () => {
  assert.equal(parseCliArgs(["chat", "--mode", "Flash"]).modelMode, "flash");
  assert.equal(parseCliArgs(["run", "task", "-m", "Auto"]).modelMode, "auto");
  assert.equal(parseCliArgs(["chat", "--mode", "MAX"]).modelMode, "max");
  assert.throws(
    () => parseCliArgs(["chat", "--mode", "turbo"]),
    /Unknown model mode turbo/,
  );
});

test("parseCliArgs enables the explicit required-change contract", () => {
  const parsed = parseCliArgs([
    "run", "repair files", "--require-change",
    "--allow-file", "src/a.js", "--allow-file", "src/b.js",
    "--require-file", "src/a.js",
  ]);
  assert.equal(parsed.requireChange, true);
  assert.deepEqual(parsed.allowedFiles, ["src/a.js", "src/b.js"]);
  assert.deepEqual(parsed.requiredFiles, ["src/a.js"]);
});

test("parseCliArgs fails closed for incomplete file constraints", () => {
  assert.throws(
    () => parseCliArgs(["run", "repair", "--allow-file"]),
    /--allow-file requires a relative workspace path/,
  );
  assert.throws(
    () => parseCliArgs(["run", "repair", "--require-file", "--verbose"]),
    /--require-file requires a relative workspace path/,
  );
  assert.throws(
    () => parseCliArgs(["run", "repair", "--profile"]),
    /--profile requires a profile name/,
  );
  assert.throws(
    () => parseCliArgs(["run", "repair", "--dir"]),
    /--dir requires a workspace path/,
  );
});

test("parseCliArgs rejects unknown profiles instead of falling back to local", () => {
  assert.throws(
    () => parseCliArgs(["run", "repair", "--profile", "claude-sonet"]),
    /Unknown profile claude-sonet/,
  );
});

test("PROFILES has valid configuration profiles", () => {
  assert.ok(PROFILES.local);
  assert.ok(PROFILES["local-expert"]);
  assert.ok(PROFILES["local-24b"]);
  assert.ok(PROFILES.auto);
  assert.ok(PROFILES["claude-sonnet"]);
  assert.ok(PROFILES["claude-opus"]);
  assert.equal(PROFILES.local.pinnedAlias, "ollama-local-coder");
  assert.equal(PROFILES["local-expert"].pinnedAlias, "ollama-qwen38-expert");
  assert.equal(PROFILES["local-24b"].pinnedAlias, "ollama-devstral");
});

test("model modes expose Flash, Auto, and Max", () => {
  assert.deepEqual(Object.keys(MODEL_MODES), ["flash", "auto", "max"]);
  assert.equal(selectProfileForMode("flash", "anything", { expertQualified: true }).profile, "local");
  assert.equal(selectProfileForMode("max", "anything", { expertQualified: true }).profile, "local-expert");
});

test("Auto keeps simple work light and routes complex work to the qualified expert", () => {
  const simple = selectProfileForMode("auto", "Fix this typo", { expertQualified: true });
  const complex = selectProfileForMode(
    "auto",
    "Debug and refactor this multi-file concurrency system and find the root cause",
    { expertQualified: true },
  );
  assert.equal(simple.profile, "local");
  assert.equal(complex.profile, "local-expert");
  assert.ok(modelTaskComplexity("debug multi-file concurrency") >= 2);
});

test("Auto and Max fail safe while the expert model is not qualified", () => {
  assert.equal(
    selectProfileForMode("auto", "refactor multi-file concurrency", { expertQualified: false }).profile,
    "local",
  );
  assert.throws(
    () => selectProfileForMode("max", "task", { expertQualified: false }),
    /Max is locked/,
  );
});

test("local profile matches OpenCode's 4096-token output contract", () => {
  const parsed = parseCliArgs(["run", "build website", "--profile", "local"]);
  const env = buildFrontierEnvironment(parsed, PROFILES.local, "test-access-token", {});

  assert.equal(env.GATEWAY_MAX_OUTPUT_TOKENS, "4096");
  assert.equal(env.GATEWAY_DEFAULT_OUTPUT_TOKENS, "4096");
  assert.equal(env.GATEWAY_UPSTREAM_TIMEOUT_MS, "600000");
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
});

test("explicit gateway runtime limits override profile defaults", () => {
  const parsed = parseCliArgs(["run", "build website", "--profile", "local"]);
  const env = buildFrontierEnvironment(parsed, PROFILES.local, "test-access-token", {
    GATEWAY_MAX_OUTPUT_TOKENS: "8192",
    GATEWAY_DEFAULT_OUTPUT_TOKENS: "2048",
    GATEWAY_UPSTREAM_TIMEOUT_MS: "300000",
  });

  assert.equal(env.GATEWAY_MAX_OUTPUT_TOKENS, "8192");
  assert.equal(env.GATEWAY_DEFAULT_OUTPUT_TOKENS, "2048");
  assert.equal(env.GATEWAY_UPSTREAM_TIMEOUT_MS, "300000");
});

test("required-change local runs select the compact structured lane", () => {
  const parsed = parseCliArgs(["run", "repair files", "--profile", "local", "--require-change"]);
  const env = buildFrontierEnvironment(parsed, PROFILES.local, "test-access-token", {});
  assert.match(env.GATEWAY_LANES_FILE, /lanes\.controlled-local-coder-8k\.json$/);
  assert.equal(env.GATEWAY_PINNED_ALIAS, "ollama-local-coder");
  assert.equal(PROFILES.local.structuredLocalModel.source, "qwen2.5-coder:14b-instruct");
  assert.equal(PROFILES.local.structuredLocalModel.model, "frontier-qwen2.5-coder-14b-8k");
  assert.equal(PROFILES.local.structuredLocalModel.contextTokens, 8192);
  assert.equal(PROFILES.local.structuredSnapshotMaxBytes, 24_576);
});

test("Qwen3.8 expert required-change runs select the bounded isolated lane", () => {
  const parsed = parseCliArgs(["run", "repair files", "--profile", "local-expert", "--require-change"]);
  const env = buildFrontierEnvironment(parsed, PROFILES["local-expert"], "test-access-token", {});
  assert.match(env.GATEWAY_LANES_FILE, /lanes\.controlled-qwen38-expert\.json$/);
  assert.equal(env.GATEWAY_PINNED_ALIAS, "ollama-qwen38-expert");
  assert.equal(PROFILES["local-expert"].structuredLocalModel.source, "hf.co/bartowski/Qwen3.8-27B-GGUF:IQ3_M");
  assert.equal(PROFILES["local-expert"].structuredLocalModel.contextTokens, 8192);
  assert.equal(PROFILES["local-expert"].structuredLocalModel.minimumFreeMemoryBytes, 10 * 1024 ** 3);
});

test("Qwen3.8 expert refuses low free memory before contacting Ollama", async () => {
  let calls = 0;
  await assert.rejects(
    ensureLocalProfileModel(PROFILES["local-expert"], {
      totalMemoryBytes: 24 * 1024 ** 3,
      freeMemoryBytes: 8 * 1024 ** 3,
      allowHighMemory: false,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({});
      },
    }),
    /requires at least 10 GB free memory/,
  );
  assert.equal(calls, 0);
});

test("Qwen3.8 expert prepares an 8K ChatML alias for imported GGUF chat requests", async () => {
  const requests = [];
  const result = await ensureLocalProfileModel(PROFILES["local-expert"], {
    totalMemoryBytes: 24 * 1024 ** 3,
    freeMemoryBytes: 18 * 1024 ** 3,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith("/api/show") && requests.length === 1) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith("/api/show")) {
        return Response.json({
          modelfile: "FROM /tmp/sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nFROM /tmp/sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        });
      }
      return Response.json({ status: "success" });
    },
  });
  assert.equal(result.created, true);
  const create = requests.find((request) => request.url.endsWith("/api/create")).body;
  assert.equal(create.from, undefined);
  assert.deepEqual(create.files, {
    "model.gguf": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(create.parameters.num_ctx, 8192);
  assert.deepEqual(create.parameters.stop, ["<|im_end|>"]);
  assert.match(create.template, /<\|im_start\|>/);
  assert.match(create.template, /\.Messages/);
});

test("high-memory local profile prepares a stable 32K Ollama model alias", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith("/api/show")) return new Response("not found", { status: 404 });
    return Response.json({ status: "success" });
  };

  const result = await ensureLocalProfileModel(PROFILES["local-24b"], {
    fetchImpl,
    totalMemoryBytes: 64 * 1024 ** 3,
  });

  assert.deepEqual(result, { required: true, created: true });
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1:11434/api/show",
      body: { model: "frontier-devstral-24b-32k" },
    },
    {
      url: "http://127.0.0.1:11434/api/create",
      body: {
        model: "frontier-devstral-24b-32k",
        from: "devstral-small-2:24b-instruct-2512-q4_K_M",
        parameters: { num_ctx: 32768 },
        stream: false,
      },
    },
  ]);
});

test("high-memory local profile reuses a correctly configured Ollama alias", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ parameters: "temperature 0.15\nnum_ctx 32768" });
  };

  const result = await ensureLocalProfileModel(PROFILES["local-24b"], {
    fetchImpl,
    totalMemoryBytes: 64 * 1024 ** 3,
  });

  assert.deepEqual(result, { required: true, created: false });
  assert.equal(calls, 1);
});

test("24B profile refuses an unsafe high-memory model before contacting Ollama", async () => {
  let calls = 0;
  assert.throws(
    () => assertLocalProfileCapacity(PROFILES["local-24b"], {
      totalMemoryBytes: 24 * 1024 ** 3,
      allowHighMemory: false,
    }),
    /requires at least 32 GB system memory/,
  );
  await assert.rejects(
    ensureLocalProfileModel(PROFILES["local-24b"], {
      totalMemoryBytes: 24 * 1024 ** 3,
      allowHighMemory: false,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({});
      },
    }),
    /requires at least 32 GB system memory/,
  );
  assert.equal(calls, 0);
});

test("missing local model source reports the exact installation command", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return new Response("not found", { status: 404 });
  };
  await assert.rejects(
    ensureLocalProfileModel(
      { localModel: PROFILES.local.structuredLocalModel },
      { fetchImpl, totalMemoryBytes: 24 * 1024 ** 3 },
    ),
    /ollama pull qwen2\.5-coder:14b-instruct/,
  );
  assert.equal(calls, 2);
});

test("local profile unloads its dedicated Ollama alias after a run", async () => {
  let request;
  const result = await unloadLocalProfileModel(
    { localModel: PROFILES.local.structuredLocalModel },
    {
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return Response.json({ done: true });
      },
    },
  );
  assert.deepEqual(result, { required: true, unloaded: true });
  assert.deepEqual(request, {
    url: "http://127.0.0.1:11434/api/generate",
    body: {
      model: "frontier-qwen2.5-coder-14b-8k",
      keep_alive: 0,
      stream: false,
    },
  });
});

/* A fake `opencode` in a temp directory, so these hold on a machine without
   one — the release gate runs on a clean runner, and a test that asserts the
   operator's own install is a test of the operator's machine. */
function fakeOpenCode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-"));
  const bin = path.join(dir, "opencode");
  fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  return { dir, bin };
}

test("findOpenCodeBinary discovers opencode on PATH", () => {
  const { dir, bin } = fakeOpenCode();
  const empty = path.join(dir, "empty");
  fs.mkdirSync(empty);
  assert.equal(findOpenCodeBinary(undefined, [empty, dir].join(path.delimiter)), bin);
});

test("findOpenCodeBinary honors an explicit path over PATH", () => {
  const { dir, bin } = fakeOpenCode();
  const other = fakeOpenCode();
  assert.equal(findOpenCodeBinary(bin, other.dir), bin);
  assert.equal(findOpenCodeBinary(path.join(dir, "missing"), other.dir), other.bin);
});

test("runOpenCode terminates the streamed child when the session is cancelled", async () => {
  const controller = new AbortController();
  const pending = runOpenCode(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    process.env,
    process.cwd(),
    5_000,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 20);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, "SIGTERM");
});

test("listAvailableSkills returns registered skills", () => {
  const skills = listAvailableSkills();
  assert.ok(skills.length >= 2);
  const names = skills.map((s) => s.name);
  assert.ok(names.includes("website-builder"));
  assert.ok(names.includes("frontiercut-copilot"));
});

test("loadSkillContent retrieves skill text", () => {
  const content = loadSkillContent("website-builder");
  // Assert on the skill's frontmatter identity, not on prose. The body is
  // rewritten whenever the skill is; its title is not the contract, the name is.
  assert.ok(typeof content === "string" && content.includes("name: website-builder"));
});

test("workspaceDigest changes with workspace content", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-digest-"));
  try {
    fs.writeFileSync(path.join(directory, "file.txt"), "before");
    const before = workspaceDigest(directory);
    fs.writeFileSync(path.join(directory, "file.txt"), "after");
    assert.notEqual(workspaceDigest(directory), before);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("workspaceDigest ignores hidden files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-digest-hidden-"));
  try {
    fs.writeFileSync(path.join(directory, "source.js"), "stable");
    fs.writeFileSync(path.join(directory, ".env"), "SECRET=before");
    const before = workspaceDigest(directory);
    fs.writeFileSync(path.join(directory, ".env"), "SECRET=after");
    assert.equal(workspaceDigest(directory), before);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("workspaceTextSnapshot includes source text but excludes dotfiles and binaries", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-snapshot-"));
  try {
    fs.writeFileSync(path.join(directory, "source.js"), "export const ready = true;");
    fs.writeFileSync(path.join(directory, ".env"), "SECRET=never-include");
    fs.writeFileSync(path.join(directory, "image.png"), Buffer.from([0, 1, 2]));
    const snapshot = workspaceTextSnapshot(directory);
    assert.match(snapshot, /source\.js/);
    assert.match(snapshot, /ready = true/);
    assert.doesNotMatch(snapshot, /SECRET|image\.png/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
