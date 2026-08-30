import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, PROFILES, findOpenCodeBinary, listAvailableSkills, loadSkillContent } from "./frontier-runner.js";

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

test("PROFILES has valid configuration profiles", () => {
  assert.ok(PROFILES.local);
  assert.ok(PROFILES.auto);
  assert.ok(PROFILES["claude-sonnet"]);
  assert.ok(PROFILES["claude-opus"]);
  assert.equal(PROFILES.local.pinnedAlias, "ollama-devstral");
});

test("findOpenCodeBinary discovers opencode executable", () => {
  const bin = findOpenCodeBinary();
  assert.ok(typeof bin === "string" && bin.length > 0);
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
  assert.ok(typeof content === "string" && content.includes("Website Builder"));
});
