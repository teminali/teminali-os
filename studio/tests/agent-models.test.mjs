import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentModels, readResolutions, recordResolution } from "../server/agent-models.js";

/**
 * The point of these is the provenance rule: a value we shipped must never be
 * presented as a value we observed. Everything else in this module is
 * assembling three sources; that is the one thing it must not get wrong.
 */

function fakeHome({ codexModel, claudeModel } = {}) {
  const home = mkdtempSync(join(tmpdir(), "agent-models-"));
  if (codexModel !== undefined) {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `model = "${codexModel}"\nmodel_reasoning_effort = "high"\n\n[projects."/somewhere"]\nmodel = "should-be-ignored"\n`,
    );
  }
  if (claudeModel !== undefined) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: claudeModel }));
  }
  return home;
}

test("the operator's configured model is read from their own CLI config", async () => {
  const home = fakeHome({ codexModel: "gpt-5.6-sol", claudeModel: "opus" });
  const models = await agentModels({ home });
  assert.equal(models.codex.configured, "gpt-5.6-sol");
  assert.equal(models.claude.configured, "opus");

  const codexDefault = models.codex.models.find((m) => m.id === null);
  assert.equal(codexDefault.resolves, "gpt-5.6-sol");
  assert.equal(codexDefault.source, "config", "a config read is a fact, and must be labelled as one");
});

test("a project-scoped model does not masquerade as the global default", async () => {
  // config.toml lists `[projects."…"]` tables after the root one, each able to
  // set its own model. Only the root table describes what a fresh run will use.
  const home = fakeHome({ codexModel: "gpt-5.6-sol" });
  const models = await agentModels({ home });
  assert.equal(models.codex.configured, "gpt-5.6-sol");
  assert.notEqual(models.codex.configured, "should-be-ignored");
});

test("missing config is reported as unknown rather than invented", async () => {
  const home = fakeHome();
  const models = await agentModels({ home });
  assert.equal(models.claude.configured, null);
  const claudeDefault = models.claude.models.find((m) => m.id === null);
  assert.equal(claudeDefault.resolves, null);
  assert.equal(claudeDefault.source, "unknown");
});

test("a shipped resolution is labelled catalog, never observed", async () => {
  const home = fakeHome();
  const models = await agentModels({ home });
  const sonnet = models.claude.models.find((m) => m.id === "sonnet");
  assert.equal(sonnet.resolves, "claude-sonnet-5");
  assert.equal(sonnet.source, "catalog");
  assert.equal(sonnet.observedAt, null);
});

test("a codex entry resolves to itself — its id is already the slug", async () => {
  const home = fakeHome();
  const models = await agentModels({ home });
  const sol = models.codex.models.find((m) => m.id === "gpt-5.6-sol");
  assert.equal(sol.resolves, "gpt-5.6-sol");
});

test("what the CLI reported overrides what we shipped", async () => {
  const home = fakeHome();
  const storePath = join(home, "agent-models.json");

  await recordResolution(storePath, "claude", "sonnet", "claude-sonnet-6");
  const models = await agentModels({ home, storePath });

  const sonnet = models.claude.models.find((m) => m.id === "sonnet");
  assert.equal(sonnet.resolves, "claude-sonnet-6", "an observation must win over the shipped guess");
  assert.equal(sonnet.source, "observed");
  assert.ok(sonnet.observedAt, "an observation carries when it was made");

  // Untouched entries keep their shipped value and their honest label.
  assert.equal(models.claude.models.find((m) => m.id === "haiku").source, "catalog");
});

test("the default lane learns its resolution too", async () => {
  const home = fakeHome();
  const storePath = join(home, "agent-models.json");
  await recordResolution(storePath, "claude", null, "claude-opus-5");
  const models = await agentModels({ home, storePath });
  const fallback = models.claude.models.find((m) => m.id === null);
  assert.equal(fallback.resolves, "claude-opus-5");
  assert.equal(fallback.source, "observed");
});

test("recording is idempotent and never throws on an unwritable path", async () => {
  const home = fakeHome();
  const storePath = join(home, "nested", "agent-models.json");
  await recordResolution(storePath, "claude", "opus", "claude-opus-5");
  await recordResolution(storePath, "claude", "opus", "claude-opus-5");
  const store = await readResolutions(storePath);
  assert.equal(store.claude.opus.resolved, "claude-opus-5");

  // A failure to remember must never surface as a failed turn.
  await assert.doesNotReject(() => recordResolution("/proc/nope/agent.json", "claude", "opus", "x"));
  await assert.doesNotReject(() => recordResolution(storePath, "claude", "opus", null));
});
