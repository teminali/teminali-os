/**
 * The editor's core verbs, exercised against stand-in stores.
 *
 * `toolRegistry.ts` cannot be imported by plain Node as it stands —
 * `tests/media-consent-gate.test.mjs` says why: it reaches the stores
 * through extensionless specifiers, and the modules behind them import
 * types as values, which type stripping cannot resolve. The other suites
 * answered that by asserting over the source text, which cannot show
 * that a command reaches the action it names.
 *
 * So the specifiers are answered here instead. A resolve hook points the
 * seven modules the registry imports at stubs, and everything else —
 * schema validation, the dispatcher, every handler — is the real file.
 * The stubs record what was called, which is the whole question these
 * tests ask: the store's own methods are covered by the store's tests,
 * and what was missing was whether "pause" reaches `setIsPlaying(false)`
 * and whether a razor that cut nothing still claims a cut.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

/* ── Harness ──────────────────────────────────────────────────────────────── */

/** Specifier as `toolRegistry.ts` writes it → the stub that answers it. */
const STUBS = {
  "../store/timelineStore": `
    export const useTimelineStore = { getState: () => globalThis.__videoStubs.timeline };
    export const findClipById = (tracks, id) => {
      for (const track of tracks ?? []) {
        for (const clip of track.clips ?? []) if (clip.id === id) return clip;
      }
      return undefined;
    };
    export const getContentEndMs = () => 0;
  `,
  "../store/projectStore": `
    export const useProjectStore = { getState: () => globalThis.__videoStubs.project };
  `,
  "../engine/propertyPath": `export const describeClipProperties = () => ({});`,
  "../engine/captionWorkflow": `export const runCaptionWorkflow = async () => ({});`,
  "../store/recorderStore": `
    export const useRecorderStore = { getState: () => globalThis.__videoStubs.recorder };
  `,
  "../engine/recordingProject": `export const TUTORIAL_ASSEMBLE = {};`,
  /* The export pipeline is reached through a dynamic import inside the
     handler, so this stub also proves the import is dynamic: a top-level
     one would be resolved from a different parent and miss the hook. */
  "../engine/exportPipeline": `
    export const canExport = () => globalThis.__videoStubs.exporter.canExport();
    export const runExport = (request) => globalThis.__videoStubs.exporter.runExport(request);
  `,
};

const stubUrl = (specifier) => `stub:${specifier.replace(/[^a-zA-Z]/g, "")}`;
const byUrl = new Map(Object.entries(STUBS).map(([specifier, source]) => [stubUrl(specifier), source]));

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Only the registry's own imports; nothing else in the graph is faked.
    if (specifier in STUBS && context.parentURL?.endsWith("/video/mcp/toolRegistry.ts")) {
      return { url: stubUrl(specifier), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (byUrl.has(url)) return { format: "module", source: byUrl.get(url), shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { executeTool, EXPOSED_TOOLS, TOOL_BUDGET } = await import(
  new URL("../src/video/mcp/toolRegistry.ts", import.meta.url).href
);

/**
 * Install a timeline that records every call the handlers make.
 *
 * The methods behave the way the real ones do where the difference is
 * visible to a handler — `setPlayheadMs` clamps at zero, `insertClip`
 * returns a minted id whether or not it landed — because those are the
 * behaviours the tools are written against.
 */
function stubStores(options = {}) {
  const {
    tracks = [],
    mediaPool = [],
    playheadMs = 0,
    isPlaying = false,
    selectedClipIds = [],
    selectedTrackId = null,
    durationMs = 60_000,
    split = { attempted: 0, cut: 0 },
    deletion = { deleted: [], refused: [] },
    undoMoved = true,
    redoMoved = true,
    exporterPresent = true,
    exportOutcome = { ok: true, outputPath: "/Videos/seed.mp4", frames: 120, bytes: 4096 },
    insertLands = true,
  } = options;

  const calls = [];
  const find = (id) => timeline.tracks.find((t) => t.id === id);

  const timeline = {
    calls,
    tracks,
    mediaPool,
    playheadMs,
    isPlaying,
    selectedClipIds,
    selectedTrackId,
    markers: [],
    setPlayheadMs(ms) {
      calls.push(["setPlayheadMs", ms]);
      timeline.playheadMs = Math.max(0, Math.round(ms));
    },
    nudgePlayhead(delta) {
      calls.push(["nudgePlayhead", delta]);
      timeline.playheadMs = Math.max(0, timeline.playheadMs + delta);
    },
    setIsPlaying(playing) {
      calls.push(["setIsPlaying", playing]);
      timeline.isPlaying = playing;
    },
    togglePlay(programEndMs) {
      calls.push(["togglePlay", programEndMs]);
      const starting = !timeline.isPlaying;
      timeline.isPlaying = starting;
      if (starting && timeline.playheadMs >= programEndMs) timeline.playheadMs = 0;
    },
    splitAtPlayhead() {
      calls.push(["splitAtPlayhead"]);
      return split;
    },
    deleteSelected() {
      calls.push(["deleteSelected"]);
      return deletion;
    },
    undo() {
      calls.push(["undo"]);
      return undoMoved;
    },
    redo() {
      calls.push(["redo"]);
      return redoMoved;
    },
    selectClip(clipId) {
      calls.push(["selectClip", clipId]);
      timeline.selectedClipIds = [clipId];
    },
    clearSelection() {
      calls.push(["clearSelection"]);
      timeline.selectedClipIds = [];
    },
    setTrackMute(trackId, muted) {
      calls.push(["setTrackMute", trackId, muted]);
      const track = find(trackId);
      if (!track) return false;
      track.muted = muted ?? !track.muted;
      return true;
    },
    setTrackSolo(trackId, solo) {
      calls.push(["setTrackSolo", trackId, solo]);
      const track = find(trackId);
      if (!track) return false;
      track.solo = solo ?? !track.solo;
      return true;
    },
    setTrackVolume(trackId, volume) {
      calls.push(["setTrackVolume", trackId, volume]);
      const track = find(trackId);
      if (!track || !Number.isFinite(volume)) return false;
      track.volume = Math.max(0, Math.min(2, volume));
      return true;
    },
    insertClip(trackId, asset, startTimeMs) {
      calls.push(["insertClip", trackId, asset.id, startTimeMs]);
      const track = find(trackId);
      // The real one mints the id before it decides, and hands it back
      // whether or not the clip landed. That is what `insert_clip` checks.
      if (track && insertLands) {
        track.clips.push({
          id: "clip_new",
          trackId,
          name: asset.name,
          startTimeMs,
          durationMs: asset.durationMs,
        });
      }
      return "clip_new";
    },
    beginTransaction() { calls.push(["beginTransaction"]); },
    commitTransaction(label) { calls.push(["commitTransaction", label]); },
    cancelTransaction() { calls.push(["cancelTransaction"]); },
  };

  globalThis.__videoStubs = {
    timeline,
    project: { project: { durationMs } },
    recorder: {},
    exporter: {
      canExport: () => exporterPresent,
      runExport: async (request) => {
        calls.push(["runExport", request]);
        return exportOutcome;
      },
    },
  };
  return globalThis.__videoStubs;
}

const named = (name, calls) => calls.filter((call) => call[0] === name);
const videoTrack = (over = {}) => ({
  id: "V1", type: "video", name: "Video 1", index: 0,
  muted: false, solo: false, locked: false, volume: 1, clips: [], ...over,
});

/* ── The dispatcher ───────────────────────────────────────────────────────── */

test("all eleven commands are declared, and each reaches its own store action", async () => {
  const table = [
    ["play_pause", {}, "togglePlay"],
    ["play", {}, "togglePlay"],
    ["pause", {}, "setIsPlaying"],
    ["set_playhead", { ms: 4000 }, "setPlayheadMs"],
    ["nudge", { ms: -250 }, "nudgePlayhead"],
    ["split", {}, "splitAtPlayhead"],
    ["delete_selected", {}, "deleteSelected"],
    ["undo", {}, "undo"],
    ["redo", {}, "redo"],
    ["select_clip", { clipId: "c1" }, "selectClip"],
    ["clear_selection", {}, "clearSelection"],
  ];

  for (const [command, args, action] of table) {
    const { timeline } = stubStores({
      // Enough state that the honest commands have something to report.
      playheadMs: 1000,
      isPlaying: command === "pause",
      selectedClipIds: ["c1"],
      tracks: [videoTrack({ clips: [{ id: "c1", trackId: "V1", name: "A roll", startTimeMs: 0, durationMs: 5000 }] })],
      split: { attempted: 1, cut: 1 },
      deletion: { deleted: ["c1"], refused: [] },
    });

    const result = await executeTool("timeline_command", { command, ...args });
    assert.equal(result.success, true, `${command}: ${result.error}`);
    assert.equal(named(action, timeline.calls).length, 1, `${command} must call ${action}`);
    assert.equal(result.data.command, command);
  }
});

test("play is absolute: it never pauses a transport that is already running", async () => {
  const { timeline } = stubStores({ isPlaying: true });
  const result = await executeTool("timeline_command", { command: "play" });

  assert.equal(result.success, true);
  assert.equal(result.data.playing, true, "play must not turn playback off");
  assert.equal(result.data.changed, false);
  assert.deepEqual(timeline.calls, [], "nothing is written when it is already playing");
  assert.equal(timeline.isPlaying, true);
});

test("pause while already paused is reported as already-paused, not as a change", async () => {
  const { timeline } = stubStores({ isPlaying: false });
  const result = await executeTool("timeline_command", { command: "pause" });

  assert.equal(result.success, true);
  assert.equal(result.data.changed, false);
  assert.match(result.data.note, /already paused/i);
  assert.deepEqual(timeline.calls, []);
});

test("play rewinds a finished pass instead of leaving the playhead on the end", async () => {
  // The store's own rule, reached through it rather than copied: a pass
  // that ended parks the playhead on the end, and starting from there is
  // undone on the next frame.
  const { timeline } = stubStores({ isPlaying: false, playheadMs: 60_000, durationMs: 60_000 });
  const result = await executeTool("timeline_command", { command: "play" });

  assert.equal(result.data.playing, true);
  assert.equal(result.data.changed, true);
  assert.equal(timeline.playheadMs, 0, "a second play must replay, not sit at the end");
});

test("play_pause still flips, and it is handed the project duration", async () => {
  const { timeline } = stubStores({ isPlaying: true, durationMs: 42_000 });
  const result = await executeTool("timeline_command", { command: "play_pause" });

  assert.equal(result.data.playing, false);
  assert.deepEqual(named("togglePlay", timeline.calls), [["togglePlay", 42_000]]);
});

/* ── Missing arguments ────────────────────────────────────────────────────── */

test("a command missing its argument is a returned error, not a crash or a default", async () => {
  for (const command of ["set_playhead", "nudge"]) {
    const { timeline } = stubStores({ playheadMs: 7000 });
    const result = await executeTool("timeline_command", { command });

    assert.equal(result.success, false, `${command} must refuse without ms`);
    assert.match(result.error, /needs ms/);
    assert.deepEqual(timeline.calls, [], `${command} must not move the playhead to a defaulted 0`);
    assert.equal(timeline.playheadMs, 7000);
  }

  const { timeline } = stubStores();
  const select = await executeTool("timeline_command", { command: "select_clip" });
  assert.equal(select.success, false);
  assert.match(select.error, /needs clipId/);
  assert.deepEqual(timeline.calls, []);

  // And a command that is not one of the eleven is refused by the schema.
  const unknown = await executeTool("timeline_command", { command: "render" });
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /Invalid arguments for timeline_command/);
});

/* ── The razor ────────────────────────────────────────────────────────────── */

test("a split that cut nothing does not report success", async () => {
  // Both shapes of nothing: the playhead over no clip at all, and a
  // playhead that aimed at a clip and did not land inside it.
  stubStores({ split: { attempted: 0, cut: 0 } });
  const nothingUnderIt = await executeTool("timeline_command", { command: "split" });
  assert.equal(nothingUnderIt.success, false);
  assert.match(nothingUnderIt.error, /Nothing was cut/);

  stubStores({ split: { attempted: 2, cut: 0 } });
  const missed = await executeTool("timeline_command", { command: "split" });
  assert.equal(missed.success, false);
  assert.match(missed.error, /aimed at 2 clip\(s\) and split 0/);

  stubStores({ split: { attempted: 2, cut: 1 } });
  const cut = await executeTool("timeline_command", { command: "split" });
  assert.equal(cut.success, true);
  assert.deepEqual(
    { attempted: cut.data.attempted, cut: cut.data.cut },
    { attempted: 2, cut: 1 },
    "a partial cut reports the store's real numbers",
  );
});

test("delete_selected refuses rather than claim a deletion, and carries the refusals", async () => {
  stubStores({ deletion: { deleted: [], refused: [{ clipId: "c1", reason: "locked" }] } });
  const refused = await executeTool("timeline_command", { command: "delete_selected" });
  assert.equal(refused.success, false);
  assert.match(refused.error, /c1: locked/);

  stubStores({ deletion: { deleted: ["c1"], refused: [{ clipId: "c2", reason: "locked" }] } });
  const partial = await executeTool("timeline_command", { command: "delete_selected" });
  assert.equal(partial.success, true);
  assert.deepEqual(partial.data.deleted, ["c1"]);
  assert.deepEqual(partial.data.refused, [{ clipId: "c2", reason: "locked" }]);
});

test("undo and redo say whether the stack actually moved", async () => {
  stubStores({ undoMoved: false });
  const nothing = await executeTool("timeline_command", { command: "undo" });
  assert.equal(nothing.success, true);
  assert.equal(nothing.data.changed, false);
  assert.match(nothing.data.note, /Nothing to undo/);

  stubStores({ undoMoved: true });
  const moved = await executeTool("timeline_command", { command: "undo" });
  assert.equal(moved.data.changed, true);
});

/* ── set_track ────────────────────────────────────────────────────────────── */

test("set_track refuses a track it cannot resolve rather than editing another one", async () => {
  const tracks = [videoTrack(), videoTrack({ id: "A1", type: "audio", name: "Audio 1", index: 1 })];

  for (const [args, pattern] of [
    [{ trackId: "ghost", muted: true }, /No track matching "ghost"/],
    [{ index: 9, muted: true }, /no track at index 9/],
    [{ muted: true }, /Name the track/],
    [{ trackId: "A1", index: 0, muted: true }, /not both/],
    [{ trackId: "A1" }, /Nothing to set/],
  ]) {
    const { timeline } = stubStores({ tracks: tracks.map((t) => ({ ...t })) });
    const result = await executeTool("set_track", args);
    assert.equal(result.success, false, `${JSON.stringify(args)} must be refused`);
    assert.match(result.error, pattern);
    assert.deepEqual(named("setTrackMute", timeline.calls), [], "nothing may be muted on a guess");
  }
});

test('set_track resolves "selected", and says so when nothing is selected', async () => {
  const { timeline } = stubStores({
    tracks: [videoTrack(), videoTrack({ id: "A1", type: "audio", name: "Audio 1", index: 1 })],
    selectedTrackId: "A1",
  });
  const result = await executeTool("set_track", { trackId: "selected", muted: true });
  assert.equal(result.success, true, result.error);
  assert.equal(result.data.trackId, "A1");
  assert.deepEqual(named("setTrackMute", timeline.calls), [["setTrackMute", "A1", true]]);

  stubStores({ tracks: [videoTrack()], selectedTrackId: null });
  const none = await executeTool("set_track", { trackId: "selected", muted: true });
  assert.equal(none.success, false);
  assert.match(none.error, /No track is selected/);
});

test("set_track applies only the fields it was sent, and separates a change from a no-op", async () => {
  const { timeline } = stubStores({
    tracks: [videoTrack({ muted: true, solo: false, volume: 1 })],
  });
  const result = await executeTool("set_track", { index: 0, muted: true, volume: 0.5 });

  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.data.changes, [{ field: "volume", from: 1, to: 0.5 }]);
  assert.deepEqual(result.data.unchanged, ["muted"], "a track already muted was not re-muted");
  assert.deepEqual(named("setTrackSolo", timeline.calls), [], "solo was not sent, so solo is untouched");
  // One call, one undo step.
  assert.equal(named("beginTransaction", timeline.calls).length, 1);
  assert.equal(named("commitTransaction", timeline.calls).length, 1);
});

/* ── insert_clip ──────────────────────────────────────────────────────────── */

const POOL = [
  { id: "a1", name: "Interview take 1", type: "video", durationMs: 8000 },
  { id: "a2", name: "Interview take 2", type: "video", durationMs: 9000 },
  { id: "a3", name: "Room tone", type: "audio", durationMs: 30_000 },
];

test("insert_clip refuses an ambiguous name instead of guessing a take", async () => {
  const { timeline } = stubStores({ tracks: [videoTrack()], mediaPool: POOL });
  const result = await executeTool("insert_clip", { name: "Interview" });

  assert.equal(result.success, false);
  assert.match(result.error, /matches 2 assets/);
  assert.match(result.error, /a1/);
  assert.match(result.error, /a2/);
  assert.deepEqual(named("insertClip", timeline.calls), []);

  // An exact name is not ambiguous against a longer one that contains it.
  const { timeline: second } = stubStores({
    tracks: [videoTrack()],
    mediaPool: [{ id: "a4", name: "Intro", type: "video", durationMs: 2000 }, { id: "a5", name: "Intro alt", type: "video", durationMs: 2000 }],
  });
  const exact = await executeTool("insert_clip", { name: "intro" });
  assert.equal(exact.success, true, exact.error);
  assert.equal(second.calls.find((c) => c[0] === "insertClip")[2], "a4");
});

test("insert_clip defaults the track to the asset's type and the start to the playhead", async () => {
  const { timeline } = stubStores({
    tracks: [videoTrack(), videoTrack({ id: "A1", type: "audio", name: "Audio 1", index: 1 })],
    mediaPool: POOL,
    playheadMs: 3200,
  });

  const result = await executeTool("insert_clip", { assetId: "a3" });
  assert.equal(result.success, true, result.error);
  assert.equal(result.data.trackId, "A1", "an audio asset goes on the audio track");
  assert.equal(result.data.startTimeMs, 3200);
  assert.equal(result.data.clipId, "clip_new");
  assert.deepEqual(named("insertClip", timeline.calls), [["insertClip", "A1", "a3", 3200]]);
});

test("insert_clip reports the id it landed, not the id the store minted", async () => {
  // `insertClip` returns its new id whether or not the clip was added.
  const { timeline } = stubStores({ tracks: [videoTrack()], mediaPool: POOL, insertLands: false });
  const result = await executeTool("insert_clip", { assetId: "a1" });

  assert.equal(result.success, false, "a clip that never landed is not an insertion");
  assert.match(result.error, /was not inserted/);
  assert.equal(named("insertClip", timeline.calls).length, 1);

  // An unknown asset never reaches the store at all.
  stubStores({ tracks: [videoTrack()], mediaPool: POOL });
  const ghost = await executeTool("insert_clip", { assetId: "nope" });
  assert.equal(ghost.success, false);
  assert.match(ghost.error, /No asset "nope"/);

  // And a locked track is refused before the store's own fallback to track 0.
  stubStores({ tracks: [videoTrack({ locked: true })], mediaPool: POOL });
  const locked = await executeTool("insert_clip", { assetId: "a1", trackId: "V1" });
  assert.equal(locked.success, false);
  assert.match(locked.error, /locked/);
});

/* ── export_project ───────────────────────────────────────────────────────── */

test("export_project surfaces canExport's refusal and never starts a render", async () => {
  const { timeline } = stubStores({ exporterPresent: false });
  const result = await executeTool("export_project", {});

  assert.equal(result.success, false);
  assert.equal(result.error, "Export needs the desktop app. A browser cannot write video files.");
  assert.deepEqual(named("runExport", timeline.calls), [], "a refused export must not render a frame");
});

test("export_project renders with the dialog's own defaults and reports the file", async () => {
  const { timeline } = stubStores({
    exportOutcome: { ok: true, outputPath: "/Videos/seed.mp4", frames: 120, bytes: 4096, hasAudio: true, droppedAudio: ["narration.wav"] },
  });
  const result = await executeTool("export_project", {});

  assert.equal(result.success, true, result.error);
  assert.deepEqual(named("runExport", timeline.calls), [
    ["runExport", { resolution: "1080p", codec: "h264", hardware: true }],
  ]);
  assert.equal(result.data.outputPath, "/Videos/seed.mp4");
  assert.deepEqual(result.data.droppedAudio, ["narration.wav"], "silence nobody was told about is reported");
});

test("a failed or cancelled export is never reported as a written file", async () => {
  stubStores({ exportOutcome: { ok: false, error: "The encoder rejected prores at 4k." } });
  const failed = await executeTool("export_project", { resolution: "4k", codec: "prores" });
  assert.equal(failed.success, false);
  assert.equal(failed.error, "The encoder rejected prores at 4k.");

  stubStores({ exportOutcome: { ok: false, canceled: true } });
  const cancelled = await executeTool("export_project", {});
  assert.equal(cancelled.success, false);
  assert.match(cancelled.error, /cancelled/);
});

/* ── The surface ──────────────────────────────────────────────────────────── */

test("the four verbs are exposed, and the surface is still inside its budget", () => {
  for (const name of ["timeline_command", "set_track", "insert_clip", "export_project"]) {
    assert.ok(EXPOSED_TOOLS.includes(name), `${name} must be reachable from outside the renderer`);
  }
  assert.equal(EXPOSED_TOOLS.length, 13);
  assert.ok(EXPOSED_TOOLS.length <= TOOL_BUDGET, `${EXPOSED_TOOLS.length} exposed against a budget of ${TOOL_BUDGET}`);
});
