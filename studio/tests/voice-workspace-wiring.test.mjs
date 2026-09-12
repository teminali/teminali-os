/**
 * "Switch to DukaBot" points the shell at DukaBot, and never mid-run.
 *
 * `workspaceActions.ts` resolves a heard name to a path and is tested on its
 * own terms in `voice-workspace-actions.test.mjs`. This file tests the other
 * half: the arrangement in `TemiVoiceStage.tsx` that turns a resolved path into
 * a store call. The component is React and this suite cannot mount it, so what
 * is pinned here is order and argument choice — the four places where getting
 * it wrong is expensive and silent rather than loud.
 *
 * The `!busy` gate is the load-bearing one, and it is a measured hazard rather
 * than a precaution. `WorkspaceService.openProject` rebinds the workspace root
 * that every workspace and terminal route resolves against. An agent run in
 * flight resolves its relative paths against that same root, so a switch landed
 * mid-run sends the run's next Edit or Write into a different repository. That
 * failure is silent, lands in a project the operator was not even looking at,
 * and is the most expensive thing available on this lane.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const stage = await readFile(new URL("../src/components/voice/TemiVoiceStage.tsx", import.meta.url), "utf8");

/* ── The gate ─────────────────────────────────────────────────────────────── */

test("a workspace switch is refused while a run is in flight", () => {
  assert.ok(
    /if \(workspaceAction && !busy\)/.test(stage),
    "the workspace block must be gated on `!busy`; without it a mid-run switch redirects the run's writes",
  );
});

test("the run's own view of busy is read from the store, not from the render closure", () => {
  // `performVoiceTurn` is installed into the socket once. A closure copy of
  // `isTaskRunning` would be whatever it was when the socket opened.
  const order = [
    stage.indexOf("useAssistantActivityStore.getState()"),
    stage.indexOf("const busy = activity.isTaskRunning"),
    stage.indexOf("if (workspaceAction && !busy)"),
  ];
  assert.ok(order.every((index) => index > 0), "all three anchors must exist");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "busy must be read fresh before the gate reads it");
});

/* ── Ahead of the router, or the router answers it with talk ──────────────── */

test("the workspace command is parsed before the turn is routed", () => {
  const parsed = stage.indexOf("parseWorkspaceCommand(clean");
  const routed = stage.indexOf("routeVoiceTurn(clean");
  assert.ok(parsed > 0 && routed > 0, "both calls must exist");
  assert.ok(
    parsed < routed,
    "parse first: `routeVoiceTurn` files a folder name as conversation and answers it with a sentence",
  );
});

test("a handled workspace turn never falls through to the router", () => {
  const block = stage.slice(stage.indexOf("if (workspaceAction && !busy)"), stage.indexOf("const editorCommand ="));
  assert.equal(
    block.match(/\n\s+return;/g)?.length,
    4,
    "reveal, already-there, switch and the busy refusal each return early; the fourth was added when " +
      "the `!busy` gate stopped falling through in silence, which was indistinguishable from not being heard",
  );
});

/* ── Which argument goes where ────────────────────────────────────────────── */

test("a reveal uses the workspace-relative path, because the store keys on it", () => {
  assert.ok(
    /store\.revealPath\(workspaceAction\.relativePath\)/.test(stage),
    "`revealPath` keys the open set by workspace-relative path; an absolute one opens nothing",
  );
  assert.ok(
    !/revealPath\(workspaceAction\.path\)/.test(stage),
    "the absolute path must never reach `revealPath`",
  );
});

test("the store is given the gateway's confirmed path, never the parsed one", () => {
  assert.ok(
    /setWorkspacePath\(projects\.current\.path\)/.test(stage),
    "the gateway owns which root the routes read; it answers with the path it actually bound",
  );
  assert.ok(
    !/setWorkspacePath\(workspaceAction\.path\)/.test(stage),
    "passing the parsed path would stamp a guess into the store as a confirmed fact",
  );
});

test("an unconfirmed root is not allowed to decide that a folder is local", () => {
  assert.ok(
    /workspacePath: store\.workspaceRootConfirmed \? store\.workspacePath : undefined/.test(stage),
    "the initial workspacePath is a hardcoded guess; using it turns a switch into a reveal against a root we are not bound to",
  );
});

test("switching to the root already open is skipped rather than re-applied", () => {
  const skip = stage.indexOf("workspaceAction.path === store.workspacePath");
  const open = stage.indexOf("WorkspaceService.openProject(workspaceAction.path)");
  assert.ok(skip > 0 && open > 0, "both must exist");
  assert.ok(skip < open, "re-applying the current root would collapse the open tree to arrive where we already are");
});

/* ── Where the candidates come from ───────────────────────────────────────── */

test("candidates come from the gateway, because the renderer has no filesystem", () => {
  /* Two sources now, both over HTTP. `listProjects` is where he has been and
     `discoverProjectFolders` is everywhere he could go -- before the second one
     existed, a folder he had never opened was unreachable by voice however
     clearly he said its name. Neither reads a disk from the renderer. */
  assert.ok(
    /projects\.current, \.\.\.projects\.recent/.test(stage),
    "the gateway's project list is still folded into the candidates",
  );
  assert.ok(
    /WorkspaceService\.discoverProjectFolders\(/.test(stage),
    "discovered folders are the other source; without them voice reaches only the recents",
  );
  assert.ok(
    /seenName/.test(stage),
    "candidates must be deduped by NAME: `resolveFolder` refuses outright when two candidates " +
      "match exactly, so two folders sharing a name would refuse the command instead of picking one",
  );
  assert.ok(
    !/from "node:fs"|require\("fs"\)/.test(stage),
    "a filesystem import here breaks the Vite browser bundle",
  );
});

test("the candidate list is a ref, so the socket's installed handler sees it", () => {
  assert.ok(
    /workspaceCandidatesRef = useRef<FolderCandidate\[\]>\(\[\]\)/.test(stage),
    "state would be the empty array the socket opened with, forever",
  );
  assert.ok(
    /candidates: workspaceCandidatesRef\.current/.test(stage),
    "the parse must read the ref",
  );
});

/* ── One surface ──────────────────────────────────────────────────────────── */

test("every workspace confirmation is spoken, not written alongside", () => {
  const block = stage.slice(stage.indexOf("if (workspaceAction && !busy)"), stage.indexOf("const editorCommand ="));
  const spoken = block.match(/speakLineRef\.current\(/g)?.length ?? 0;
  assert.equal(
    spoken,
    5,
    "reveal, already-there, switched, failed and the busy refusal each say exactly one line",
  );
  assert.ok(
    !/appendAssistant|setTurns\(/.test(block),
    "a bubble written beside the spoken line is the double-render defect of DESIGN.md 6.0.21",
  );
});

test("a spoken turn cuts the model off before acting, as the delegate path does", () => {
  const block = stage.slice(stage.indexOf("if (workspaceAction && !busy)"), stage.indexOf("const editorCommand ="));
  const bargeIn = block.indexOf("sendBargeIn()");
  const acts = block.indexOf("store.revealPath");
  assert.ok(bargeIn > 0 && acts > 0, "both must exist inside the block");
  assert.ok(bargeIn < acts, "the model is already answering the spoken turn; cut it before the shell answers instead");
});

/* ── The trace: heard before it can be dropped ────────────────────────────── */

test("the raw transcript is traced before either echo filter can drop it", () => {
  const heard = stage.indexOf('traceVoice("heard"');
  const directiveDrop = stage.indexOf('traceVoice("dropped", { by: "directive-echo" }');
  const reportDrop = stage.indexOf('traceVoice("dropped", { by: "report-echo" }');
  assert.ok(heard > 0 && directiveDrop > 0 && reportDrop > 0, "all three call sites must exist");
  assert.ok(
    heard < directiveDrop && heard < reportDrop,
    "what the microphone actually produced must be recorded before anything downstream can drop it, or the one datum the whole diagnosis turns on is lost exactly when it matters",
  );
});

test("the directive-echo filter records a dropped trace before its silent return", () => {
  const block = stage.slice(
    stage.indexOf("if (GeminiLiveEngine.isAssistantDirectiveEcho(clean))"),
    stage.indexOf("if (isAssistantReportEcho(clean))"),
  );
  const traced = block.indexOf('traceVoice("dropped"');
  const returned = block.indexOf("return;");
  assert.ok(traced > 0 && returned > 0, "both must exist inside this branch");
  assert.ok(
    traced < returned,
    "a drop with no trace before the return is exactly the silent drop this trace exists to end",
  );
  assert.ok(/traceVoice\("dropped", \{ by: "directive-echo" \}\);/.test(block));
});

test("the report-echo filter records a dropped trace before its silent return", () => {
  const block = stage.slice(
    stage.indexOf("if (isAssistantReportEcho(clean))"),
    stage.indexOf("// Update last user bubble"),
  );
  const traced = block.indexOf('traceVoice("dropped"');
  const returned = block.indexOf("return;");
  assert.ok(traced > 0 && returned > 0, "both must exist inside this branch");
  assert.ok(
    traced < returned,
    "a drop with no trace before the return is exactly the silent drop this trace exists to end",
  );
  assert.ok(/traceVoice\("dropped", \{ by: "report-echo" \}\);/.test(block));
});

/* ── The trace: refused and held look the same ────────────────────────────── */

test("the turn trace records busy and lands before the workspace gate branches on it", () => {
  const traced = stage.indexOf('traceVoice("turn"');
  const gate = stage.indexOf("if (workspaceAction && !busy)");
  assert.ok(traced > 0 && gate > 0, "both must exist");
  assert.ok(
    traced < gate,
    "a turn the parser refused and one the busy gate held both end in silence; only a trace written ahead of the branch that treats them alike can tell them apart afterwards",
  );

  const block = stage.slice(traced, gate);
  assert.ok(
    /\bbusy,/.test(block),
    "the turn trace must carry `busy`, or a refused parse and a held gate are indistinguishable in the ring",
  );
});
