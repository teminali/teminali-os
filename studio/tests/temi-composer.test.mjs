import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The chatbox and the openers under it.
 *
 * The component is .tsx and the node runner cannot import JSX, so these read
 * the source. That is weaker than mounting it and it is chosen over nothing:
 * every failure asserted here is total — the primary input of the application
 * missing, or the landing screen never appearing — and each one has actually
 * happened in this file's history.
 */

const composerPath = new URL("../src/components/voice/TemiComposer.tsx", import.meta.url);
const stagePath = new URL("../src/components/voice/TemiVoiceStage.tsx", import.meta.url);

const composer = await readFile(composerPath, "utf8");
const stage = await readFile(stagePath, "utf8");

test("the composer owns exactly one field, and it is a textarea", () => {
  // An <input> cannot show a second line, and the Codex box is tall precisely
  // so that a paragraph is visible while it is being written — which is what
  // the old stage composer got wrong.
  assert.doesNotMatch(composer, /<input\s+(type|value|ref)=/, "the field must not be a single-line input");
  assert.equal((composer.match(/<textarea\b/g) ?? []).length, 1, "one field, unconditionally mounted");
  // Unconditional: no `{x && <textarea`. A field that has to be earned by
  // already having a value cannot be typed into.
  assert.doesNotMatch(composer, /&&\s*\(?\s*<textarea/, "the field must not be gated on any condition");
});

test("the landing screen is the seeded greeting, not an empty list", () => {
  // `dialogueHistory` starts at INITIAL_DIALOGUE, so `turns.length === 0` is
  // never true and testing for it would mean the landing screen never showed.
  assert.match(stage, /const isEmpty = turns\.length === 1 && turns\[0\]\?\.id === "init-temi"/);
  assert.doesNotMatch(stage, /const isEmpty = turns\.length === 0/);
});

test("the openers are drawn on the empty chat and nowhere else", () => {
  const uses = (stage.match(/<TemiActionRow\b/g) ?? []).length;
  assert.equal(uses, 1, "one action row");

  // It must sit in the `isEmpty ?` arm, ahead of the `) : (` that opens the
  // conversation layout.
  const branch = stage.indexOf("{isEmpty ? (");
  const otherwise = stage.indexOf(") : (", branch);
  const row = stage.indexOf("<TemiActionRow", branch);
  assert.ok(branch !== -1 && otherwise !== -1, "the stage branches on isEmpty");
  assert.ok(row > branch && row < otherwise, "the action row belongs to the empty branch only");
});

test("the box is drawn once and placed twice", () => {
  // Centred on the landing screen, docked under a conversation. Two copies of
  // the markup is how the two layouts drift apart.
  assert.equal((stage.match(/<TemiComposer\b/g) ?? []).length, 1, "one composer element");
  assert.match(stage, /const composer = \(/, "held in one binding and rendered in both arms");
  assert.equal((stage.match(/\{composer\}/g) ?? []).length, 2, "placed in both layouts");
  assert.equal((stage.match(/\{presence\}/g) ?? []).length, 2, "and so is the orb");
});

test("every opener reaches a surface that exists", () => {
  // The row's whole point: these three were already built and had nothing
  // pointing at them after the stage replaced StudioChat's render.
  assert.match(composer, /useRecorderDialogStore/, "screen recorder");
  assert.match(composer, /useProjectLibrary/, "recent projects");
  assert.match(composer, /onConnectGitHub/, "connect repos");
  // And each is actually invoked, not merely imported.
  assert.match(composer, /onClick=\{openRecorder\}/);
  assert.match(composer, /void openEntry\(entry\)/);
});

test("the process line rides in the project tab, after the project name", () => {
  // It was a pill floating between the orb and the box, renting a row of the
  // screen to say one short sentence. The tab was already drawn and already
  // half empty, so the line costs nothing there.
  const label = composer.indexOf('{projectLabel ?? "Choose project"}');
  const slot = composer.indexOf("{activity}");
  const field = composer.indexOf("<textarea");
  assert.ok(label !== -1 && slot !== -1, "the tab has a project name and an activity slot");
  assert.ok(slot > label && slot < field, "the slot sits after the name and inside the tab");

  // A button inside a button is not markup a browser honours, and the strip is
  // itself clickable — so the tab is a row of controls, not one control.
  const between = composer.slice(composer.indexOf("onClick={onChooseProject}"), slot);
  assert.ok(between.includes("</button>"), "the project button closes before the activity slot");

  // The stage wires it through the composer, not into the orb block.
  assert.match(stage, /activity=\{<ConnectedAgentActivity/, "the stage fills the slot");
  assert.ok(
    stage.indexOf("<ConnectedAgentActivity") > stage.indexOf("const composer = ("),
    "and does it in the composer, not in `presence`",
  );
});

test("the approvals chip names a rung that exists", () => {
  // Codex's static "Approve for me" would be a claim about behaviour we may
  // not be in: `manual` asks before every tool call.
  assert.match(stage, /PERMISSION_LABELS\[agentPermission\]/);
  // The chip renders what it was handed. A literal here would be that claim
  // baked in; the prose above the control may still name Codex's version.
  assert.match(composer, /<span className="truncate">\{permissionLabel\}<\/span>/);
  assert.doesNotMatch(composer, />\s*Approve for me\s*</, "no hard-coded mode label in the markup");
});
