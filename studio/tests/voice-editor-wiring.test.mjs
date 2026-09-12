/**
 * The voice lane's route into the video editor, pinned where it is fragile.
 *
 * `parseEditorCommand` is tested on its own in `voice-editor-actions.test.mjs`.
 * This file tests the arrangement in `TemiVoiceStage.tsx` that carries a parsed
 * command to `executeTool`, which the audit of 2026-09-12 found did not exist at
 * all: the router knew `converse`, `stop`, `repeat`, `hush` and `mute`, and no
 * voice-to-tool path was there for any of them to become.
 *
 * The component is React and this suite cannot mount it, so what is pinned is
 * order, gating, and which line gets spoken.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const stage = await readFile(new URL("../src/components/voice/TemiVoiceStage.tsx", import.meta.url), "utf8");

test("an editor command is parsed before the turn is routed", () => {
  const parsed = stage.indexOf("parseEditorCommand(clean)");
  const routed = stage.indexOf("const decision = routeVoiceTurn");
  assert.ok(parsed > 0 && routed > 0, "both must exist");
  assert.ok(parsed < routed, "the router would file `cut here` as conversation and answer it with a sentence");
});

test("the workspace fast path is still asked first", () => {
  // Ordering between the two fast paths, so a future edit cannot quietly swap
  // them: the workspace grammar requires a place noun and cannot swallow an
  // editor verb, but the reverse is not something to leave to chance.
  const workspace = stage.indexOf("parseWorkspaceCommand(clean");
  const editor = stage.indexOf("parseEditorCommand(clean)");
  assert.ok(workspace > 0 && editor > 0 && workspace < editor);
});

test("editor commands are only reached inside a video project", () => {
  assert.ok(
    /editorLaneOpen\(\) \? parseEditorCommand\(clean\) : null/.test(stage),
    "in a code workspace `undo that` is conversation, and reaching for an absent timeline answers it with a failure",
  );
  assert.ok(
    /isVideoProjectRef\.current = projects\.current\.kind === "video"/.test(stage),
    "the gateway already classifies the root; the shell must not invent its own answer",
  );
  /* The gate reads `isVideoProjectRef` directly whenever the gateway answered
     at all. What changed is only the case where it did NOT answer, which used
     to be indistinguishable from "not a video project" and killed the lane for
     the session — see voice-stage-gates.test.mjs. */
  assert.ok(
    /if \(projectKindKnownRef\.current\) return isVideoProjectRef\.current;/.test(stage),
    "a known code workspace must still refuse the editor lane outright",
  );
});

test("the editor path is deliberately NOT gated on a running agent", () => {
  const block = stage.slice(stage.indexOf("const editorCommand ="), stage.indexOf("const decision = routeVoiceTurn"));
  assert.ok(
    !/!busy/.test(block),
    "unlike a workspace switch, an edit lands on the timeline in front of the operator who asked for it",
  );
  // And the workspace block, which has the silent-wrong-repository hazard, still is.
  assert.ok(/if \(workspaceAction && !busy\)/.test(stage));
});

test("the registry is reached by dynamic import, not dragged into this chunk", () => {
  assert.ok(
    /import\("\.\.\/\.\.\/video\/mcp\/toolRegistry"\)/.test(stage),
    "a static import pulls the ffmpeg and caption surfaces into a screen that usually never touches the editor",
  );
  assert.ok(
    !/^import .*from "\.\.\/\.\.\/video\/mcp\/toolRegistry"/m.test(stage),
    "a top-level import of the registry defeats the point of the dynamic one",
  );
});

test("what she says comes from the result, not from the request", () => {
  assert.ok(
    /describeEditorResult\(command, result\)/.test(stage),
    "`splitAtPlayhead` succeeds with cut:0; announcing the request would report an edit that did not happen",
  );
});

test("a spoken editor turn cuts the model off before the tool runs", () => {
  const block = stage.slice(stage.indexOf("const editorCommand ="), stage.indexOf("const decision = routeVoiceTurn"));
  const barge = block.indexOf("sendBargeIn()");
  const run = block.indexOf("runEditorCommand(editorCommand)");
  assert.ok(barge > 0 && run > 0 && barge < run, "the model is already answering the spoken turn");
});

test("only the export speaks twice, and only because it is long", () => {
  const runner = stage.slice(stage.indexOf("const runEditorCommand"), stage.indexOf("// ── One switch for everything"));
  assert.ok(/const slow = command\.tool === "export_project"/.test(runner));
  assert.ok(
    /if \(slow\) speakLineRef\.current\(command\.spoken, "verbatim"\)/.test(runner),
    "silence across a job that holds the machine for minutes reads as a command never heard",
  );
  assert.ok(
    !/appendAssistant|setTurns\(/.test(runner),
    "a written bubble beside the spoken line is the double-render defect of DESIGN.md 6.0.21",
  );
});
