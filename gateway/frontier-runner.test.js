import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, PROFILES, findOpenCodeBinary } from "./frontier-runner.js";

test("parseCliArgs parses default chat command", () => {
  const parsed = parseCliArgs([]);
  assert.equal(parsed.command, "chat");
  assert.equal(parsed.profile, "local");
  assert.equal(parsed.budget, "0.20");
});

test("parseCliArgs parses run command with prompt and options", () => {
  const parsed = parseCliArgs(["run", "build website", "-p", "auto", "-b", "0.50", "-v"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.prompt, "build website");
  assert.equal(parsed.profile, "auto");
  assert.equal(parsed.budget, "0.50");
  assert.equal(parsed.verbose, true);
});

test("PROFILES has valid configuration profiles", () => {
  assert.ok(PROFILES.local);
  assert.ok(PROFILES.auto);
  assert.ok(PROFILES["claude-sonnet"]);
  assert.ok(PROFILES["claude-opus"]);
  assert.equal(PROFILES.local.pinnedAlias, "ollama-devstral-local");
});

test("findOpenCodeBinary discovers opencode executable", () => {
  const bin = findOpenCodeBinary();
  assert.ok(typeof bin === "string" && bin.length > 0);
});
