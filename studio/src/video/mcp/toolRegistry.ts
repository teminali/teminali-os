/* ═══════════════════════════════════════════════════════════════════
   MCP tool surface.

   Design principle: a SMALL number of GENERIC tools beats a large number
   of narrow ones. The agent discovers what exists (`describe_timeline`)
   and then edits anything through `patch_clip` / `set_effect_param`,
   validated by the property schema.

   Every tool declares a Zod schema, so bad arguments produce an actionable
   message instead of a silent no-op.

   ── This is a REDUCTION of `teminaliCut/src/mcp/toolRegistry.ts` ──
   That file defines 115 tools. Three of them are here, at the same path
   under `src/video/` so that adding a fourth is a copy-paste and a future
   sync is a diff. Two things the Cut's `executeTool` does are deliberately
   absent, because neither store came across in the port: it logs every call
   to `useMcpStore`, and it calls `followToolCall` (agentPresence) to make
   the editor's own UI follow the agent's work. Their absence costs the
   panel nothing — the stores the tools write to are the ones the mounted
   components render from, so an edit is visible the moment it lands.
   ═══════════════════════════════════════════════════════════════════ */

import { z } from 'zod';
/*
  The only reference this file makes outside `src/video/`, and it is a
  TYPE import — erased at build, so nothing under `src/video/` depends on
  the shell at runtime and the lift stays diffable against the Cut. The
  vocabulary is shared because the gate enforces what the tools declare;
  the declarations themselves stay here, beside the handlers they judge.
*/
import type { ConsentCapability, RequestedPath } from '../../services/mediaConsent';
import { useTimelineStore, findClipById, getContentEndMs } from '../store/timelineStore';
import { useProjectStore } from '../store/projectStore';
import type { ClipType, MediaAsset } from '../types/edl';
import { describeClipProperties } from '../engine/propertyPath';
import { runCaptionWorkflow } from '../engine/captionWorkflow';
import { useRecorderStore, type StickySettings } from '../store/recorderStore';
import { TUTORIAL_ASSEMBLE } from '../engine/recordingProject';

/* ── Tool definition ────────────────────────────────────────────── */

export interface ToolContext {
  agentName: string;
}

export interface KerfTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  category: 'discovery' | 'timeline' | 'properties' | 'effects' | 'graphics' | 'audio' | 'ai' | 'project' | 'media';
  schema: S;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown> | unknown;

  /* ── Consent ────────────────────────────────────────────────────
     Declared on the tool, in the registry, for the reason
     `agentCommands.ts` gives about its own classifier: the rule a call
     is judged by and the code that runs it stay in one file, so they
     cannot drift. `isExposed(name)` says whether a caller outside this
     renderer may reach a tool; these say what it owes first. The two
     are independent, and `services/videoToolBridge.ts` checks both.
     Designed in `src/video/P3-import-gate.md`.
     ───────────────────────────────────────────────────────────────── */

  /**
   * Capabilities this tool hands a caller. Absent means what the three
   * P2 tools mean: none — they move numbers in an in-memory store.
   */
  consent?: readonly ConsentCapability[];

  /**
   * Which arguments are paths, and what may legitimately live at each.
   *
   * The gate needs to know before the handler runs, and only this file
   * knows which argument of which tool is a path. `accepts` is per
   * argument rather than global because `ffmpeg_process`'s `lutPath` is
   * a real read of a `.cube` sidecar; a media-only rule would refuse it
   * forever and make the `lut` operation permanently dead.
   */
  consentPaths?: (args: z.infer<S>) => RequestedPath[];

  /** One extra line of weight for the prompt — the ffmpeg operation, say. */
  consentDetail?: (args: z.infer<S>) => string | undefined;

  /**
   * The schema advertised to, and enforced on, callers outside this
   * renderer; `schema` still governs the in-process chat.
   *
   * One tool, two surfaces. It exists for `ffmpeg_process`, whose
   * `custom` operation takes a raw filtergraph — and a filtergraph
   * reaches the filesystem through filters that take a filename
   * (`movie=`, `subtitles=`, `drawtext=textfile=`), so it defeats every
   * path check by construction: the gate sees the `input` and the graph
   * reads something else. Narrowing the enum here means the manifest
   * tells the model the truth, instead of an error message doing it on
   * the second try.
   */
  exposedSchema?: z.ZodTypeAny;
}

const tools: KerfTool[] = [];

function defineTool<S extends z.ZodTypeAny>(tool: KerfTool<S>): void {
  tools.push(tool as unknown as KerfTool);
}

/* ── Helpers ────────────────────────────────────────────────────── */

const timeline = () => useTimelineStore.getState();
const project = () => useProjectStore.getState();

/**
 * Make a handler's several store writes ONE undoable edit.
 *
 * Every commit deep-clones the whole timeline for the history, and the
 * store already had the mechanism (`beginTransaction` makes the caller own
 * the snapshot boundary), so a tool that writes twice should still cost the
 * user one press of undo.
 */
function asOneEdit<T>(label: string, fn: () => T): T {
  timeline().beginTransaction();
  try {
    const out = fn();
    timeline().commitTransaction(label);
    return out;
  } catch (err) {
    // Leave no half-finished edit behind, and no dangling transaction
    // depth that would swallow every later commit.
    timeline().cancelTransaction();
    throw err;
  }
}

/** Resolve a clip reference: an id, "selected", or a fuzzy name match. */
function resolveClipId(ref?: string): string {
  const state = timeline();

  if (!ref || ref === 'selected' || ref === 'current') {
    const id = state.selectedClipIds[0];
    if (!id) throw new Error('No clip is selected. Pass clipId explicitly, or select a clip first.');
    return id;
  }

  if (findClipById(state.tracks, ref)) return ref;

  // Fall back to a name match so the agent can say "the mascot layer".
  const needle = ref.toLowerCase();
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.name.toLowerCase().includes(needle)) return clip.id;
    }
  }

  throw new Error(`No clip matching "${ref}". Call describe_timeline to list the clips.`);
}

function requireUnlocked(clipId: string): void {
  const clip = findClipById(timeline().tracks, clipId);
  if (!clip) return;
  const track = timeline().tracks.find((t) => t.id === clip.trackId);
  if (clip.locked) throw new Error(`"${clip.name}" is locked. Unlock it first.`);
  if (track?.locked) {
    throw new Error(`"${clip.name}" is on locked track "${track.name}". Unlock it first.`);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   DISCOVERY — how the agent learns what it can touch
   ═══════════════════════════════════════════════════════════════════ */

defineTool({
  name: 'describe_timeline',
  category: 'discovery',
  description:
    'Read the project: tracks and clips with their ids and timing. Call this FIRST so later ' +
    'edits target real ids. Returns a SUMMARY by default — ids, names, types, start and ' +
    'duration, and a track\'s mute/lock/solo only when set. Pass detail:"full" for effects ' +
    '(with their ids), keyframe counts, speed, blend mode, clip text, markers and the media ' +
    'pool; add includeProperties:true for every editable property path.',
  schema: z.object({
    detail: z.enum(['summary', 'full']).optional()
      .describe('"summary" (default) or "full". Ask for full only when you need effect ids or timing detail'),
    includeProperties: z.boolean().optional().describe('Every editable property of every clip. Implies full, and is long'),
  }),
  handler: ({ detail, includeProperties }) => {
    const state = timeline();
    const proj = project().project;
    /*
      Summary is the default because of what the full answer costs.

      One `describe_timeline` on the seed project is 5,033 characters
      (~1.3k tokens) — and a tool result does not go away: it stays in
      the transcript and is re-sent on every later turn of the
      conversation. The model asks this question to learn clip ids, and
      then never needs the rest again. So the verbose fields are opt-in
      and the description says what asking buys.
    */
    const full = detail === 'full' || includeProperties === true;

    return {
      project: {
        name: proj.name,
        aspectRatio: proj.aspectRatio,
        fps: proj.fps,
        durationMs: proj.durationMs,
        contentEndMs: getContentEndMs(state.tracks),
        ...(full ? { width: proj.width, height: proj.height } : {}),
      },
      playheadMs: state.playheadMs,
      selectedClipIds: state.selectedClipIds,
      ...(full
        ? {
            selectedTrackId: state.selectedTrackId,
            markers: state.markers.map((m) => ({ id: m.id, timeMs: m.timeMs, kind: m.kind, label: m.label })),
            mediaPool: state.mediaPool.map((a) => ({ id: a.id, name: a.name, type: a.type, durationMs: a.durationMs })),
          }
        : {
            /* Counts, so the model can tell there is something there to
               ask for rather than concluding the project has neither. */
            ...(state.markers.length ? { markerCount: state.markers.length } : {}),
            ...(state.mediaPool.length ? { mediaPoolCount: state.mediaPool.length } : {}),
          }),
      tracks: state.tracks.map((track) => ({
        id: track.id,
        name: track.name,
        type: track.type,
        index: track.index,
        /* solo and volume were settable and unreadable: nothing in the
           tool surface reported them, so an agent could mute a mix and
           had no way to find out what it had done. In summary they are
           reported only when they are not at rest — an absent flag
           means false, which the description states. */
        ...(full
          ? { muted: track.muted, locked: track.locked, solo: track.solo, volume: track.volume }
          : {
              ...(track.muted ? { muted: true } : {}),
              ...(track.locked ? { locked: true } : {}),
              ...(track.solo ? { solo: true } : {}),
            }),
        clips: track.clips.map((clip) => ({
          id: clip.id,
          name: clip.name,
          type: clip.type,
          startMs: clip.startTimeMs,
          durationMs: clip.durationMs,
          ...(full
            ? {
                endMs: clip.startTimeMs + clip.durationMs,
                effects: clip.effects.map((e) => ({ id: e.id, type: e.type, enabled: e.enabled, intensity: e.intensity })),
                keyframeCount: clip.keyframes.length,
                speed: clip.speed.multiplier,
                blendMode: clip.blendMode,
                text: clip.textStyle?.text,
              }
            : {
                /* Which clip to ask about in full, without listing the
                   effects themselves. `set_effect_param` takes an effect
                   TYPE as well as an id, so a count is often enough. */
                ...(clip.effects.length ? { effectCount: clip.effects.length } : {}),
                ...(clip.locked ? { locked: true } : {}),
              }),
          ...(includeProperties ? { properties: describeClipProperties(clip) } : {}),
        })),
      })),
    };
  },
});

/* ═══════════════════════════════════════════════════════════════════
   PROPERTIES — the universal editing verb
   ═══════════════════════════════════════════════════════════════════ */

defineTool({
  name: 'patch_clip',
  category: 'properties',
  description:
    'Set any number of properties on a clip in one call, addressed by dotted path. ' +
    'Examples: {"transform.rotation": 45, "filters.saturation": 30, "textStyle.color": "#ff0000", "effects.glow.radius": 60}. ' +
    'This is the primary editing tool. Prefer it over narrow per-property tools.',
  schema: z.object({
    clipId: z.string().optional().describe('Clip id, clip name, or "selected"'),
    properties: z.record(z.any()).describe('Map of property path → new value'),
  }),
  handler: ({ clipId, properties }) => {
    const id = resolveClipId(clipId);
    const result = timeline().patchClip(id, properties);
    if (result.applied.length === 0 && result.errors.length > 0) {
      throw new Error(result.errors.join('; '));
    }
    /* Report what actually moved. A path that was already at the target
       value comes back as `unchanged`, which is the difference between
       "I set it" and "it was already like that". */
    const changed = result.changes.filter((c) => !Object.is(c.from, c.to));
    const unchanged = result.changes.filter((c) => Object.is(c.from, c.to)).map((c) => c.path);

    return {
      clipId: id,
      applied: result.applied,
      changes: changed.map((c) => ({ path: c.path, from: c.from, to: c.to })),
      ...(unchanged.length ? { unchanged } : {}),
      ...(result.errors.length > 0 ? { warnings: result.errors } : {}),
    };
  },
});

/* ═══════════════════════════════════════════════════════════════════
   EFFECTS
   ═══════════════════════════════════════════════════════════════════ */

defineTool({
  name: 'set_effect_param',
  category: 'effects',
  description:
    'Change one parameter of an effect already on a clip. Numbers, colour strings ' +
    '("#ff0088") and booleans are all accepted depending on the parameter; the editor ' +
    'validates and reports what it rejected rather than silently ignoring it.',
  schema: z.object({
    clipId: z.string().optional(),
    effect: z.string().describe('Effect id or effect type'),
    param: z.string().describe('Parameter key'),
    /*
      `z.any()` converted to an EMPTY JSON Schema — a property the caller
      is told nothing about, and "exposed" is not the same as "callable":
      a model with no type has to guess whether a parameter wants 40 or
      "40". A union types it without narrowing what the editor accepts.
    */
    value: z.union([z.number(), z.string(), z.boolean()])
      .describe('Number, colour string, or boolean. Whichever the parameter takes'),
  }),
  handler: ({ clipId, effect, param, value }) => {
    const id = resolveClipId(clipId);
    requireUnlocked(id);
    /*
      `setEffectParam` deliberately does not commit: the inspector's
      sliders call it on every pointer move and commit at their own call
      site, so committing in the store would push one history entry per
      mouse pixel. That left the TOOL path with no undo entry at all —
      an agent could set a parameter and the user could not take it
      back. The boundary belongs here, where one call is one edit.
    */
    return asOneEdit('Set effect parameter', () => {
      const result = timeline().setEffectParam(id, effect, param, value);
      if (!result.ok) throw new Error(result.error ?? `Could not set ${param} on "${effect}".`);
      return { clipId: id, effect, param, value };
    });
  },
});


/* ═══════════════════════════════════════════════════════════════════
   MEDIA — the first tools that touch the operator's own disk

   Everything above moves numbers in an in-memory store. Everything
   below reads a file the caller named, and one of them spawns a
   process. That is a different kind of tool and it is gated as one:
   see `consent` on each, `src/video/P3-import-gate.md` for why, and
   `services/mediaConsent.ts` for the gate itself.
   ═══════════════════════════════════════════════════════════════════ */

/**
 * The import surface's extension lists.
 *
 * Taken from the picker the Cut shows a human
 * (`teminaliCut/electron/main.ts:236`). The agent path is the SAME
 * import, so it is held to the same list — which is why the honest
 * answer to `import_media_from_path('/etc/passwd')` is "that is not
 * media" rather than a prompt whose only correct answer is no.
 */
const MEDIA_EXTENSIONS: readonly string[] = Object.freeze([
  'mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'aac', 'png', 'jpg', 'jpeg', 'webp',
]);

/** `ffmpeg_process`'s `lutPath`, and nothing else. */
const LUT_EXTENSIONS: readonly string[] = Object.freeze(['cube']);

function classifyByExtension(filePath: string): ClipType {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic'].includes(ext)) return 'image';
  return 'video';
}

/**
 * Measure a file by asking the browser to decode it.
 *
 * Lifted from the Cut. The 4s ceiling is the point: a codec Chromium
 * cannot open would otherwise hang the tool call until the bridge's own
 * timeout fired, and the caller would read "the editor wedged" when the
 * truth is "this file does not decode here".
 */
function probeMedia(url: string, type: ClipType): Promise<{
  durationMs: number;
  width?: number;
  height?: number;
  thumbnailUrl: string;
  /** False when nothing could decode this, so durationMs is a guess. */
  decoded: boolean;
  reason?: string;
}> {
  return new Promise((resolve) => {
    if (type === 'image') {
      const img = new Image();
      img.onload = () =>
        resolve({
          durationMs: 5000, width: img.naturalWidth, height: img.naturalHeight,
          thumbnailUrl: url, decoded: true,
        });
      img.onerror = () =>
        resolve({
          durationMs: 5000, thumbnailUrl: '', decoded: false,
          reason: 'the image decoder refused it. Wrong extension, or the file is corrupt',
        });
      img.src = url;
      return;
    }

    const el = document.createElement(type === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';

    let settled = false;
    const done = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      /* Release the element either way: a failed <video> holds its
         decoder open, and a folder of them leaks one per file. */
      const release = () => { el.removeAttribute('src'); el.load(); };

      if (!ok) {
        release();
        resolve({ durationMs: 5000, thumbnailUrl: '', decoded: false, reason });
        return;
      }
      const video = el as HTMLVideoElement;
      const measured = Number.isFinite(el.duration);
      const out = {
        durationMs: measured ? Math.round(el.duration * 1000) : 5000,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        thumbnailUrl: type === 'audio' ? '' : url,
        decoded: true,
        ...(measured ? {} : { decoded: false, reason: 'metadata carried no duration' }),
      };
      release();
      resolve(out);
    };

    el.onloadedmetadata = () => done(true);
    el.onerror = () => done(false, 'the media decoder refused it. Unsupported codec, or the file is corrupt');
    setTimeout(() => done(Number.isFinite(el.duration), 'timed out after 4s without metadata'), 4000);
    el.src = url;
  });
}

/**
 * Bring a file on disk into the media pool.
 *
 * Shared by `import_media_from_path`, `ffmpeg_process` and the Media
 * sidebar tab, which would otherwise each carry their own copy of the
 * URL encoding and the probe — and the encoding is exactly the sort of
 * detail that gets fixed in one of three places.
 *
 * Exported because the operator's own import gesture goes through it
 * too: one code path means the human and the agent produce identical
 * assets, and the gate is the only thing that differs between them.
 */
export async function importMediaFromPath(
  filePath: string,
  name?: string
): Promise<MediaAsset & { decoded: boolean; undecodableReason?: string }> {
  if (!filePath.startsWith('/')) {
    throw new Error(`Path must be absolute, got "${filePath}"`);
  }

  const fileName = name ?? filePath.split('/').pop() ?? 'Imported media';
  const type = classifyByExtension(filePath);

  /* file:// works because the window runs with webSecurity disabled
     (`electron/main.cjs:141`). The URL is kept as the asset's source so
     the compositor reads the original file rather than a copy in memory
     — and it is also why the gate, not the sandbox, is the control. */
  const url = `file://${encodeURI(filePath).replace(/#/g, '%23')}`;
  const probed = await probeMedia(url, type);

  const asset: MediaAsset = {
    id: `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: fileName,
    type,
    url,
    thumbnailUrl: probed.thumbnailUrl,
    durationMs: probed.durationMs,
    width: probed.width,
    height: probed.height,
    fileSizeFormatted: '-',
  };

  timeline().addMediaAsset(asset);
  /* Still added when it could not be decoded: the file may be perfectly
     good and merely unsupported by Chromium, and ffmpeg_process can
     transcode it into something that plays. What must not happen is
     reporting a clean import, so the flag rides along. */
  return { ...asset, decoded: probed.decoded, undecodableReason: probed.reason };
}

defineTool({
  name: 'list_media_pool',
  category: 'media',
  description: 'List every media asset currently imported, with ids usable by patch_clip.',
  schema: z.object({}),
  /* No consent: it reads a pool the operator already imported, so the
     file:// urls it returns disclose nothing they did not choose. It is
     also what makes the other two usable — the agent needs asset ids. */
  handler: () => ({
    assets: timeline().mediaPool.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      durationMs: a.durationMs,
      ...(a.width ? { dimensions: `${a.width}×${a.height}` } : {}),
    })),
  }),
});

defineTool({
  name: 'import_media_from_path',
  category: 'media',
  description:
    'Import a media file from an absolute path on disk into the project media pool. ' +
    'Use after downloading or locating a file. Returns the new asset id. The operator is ' +
    'asked before a path they have not already granted is read.',
  schema: z.object({
    path: z.string().describe('Absolute path to a video, audio or image file'),
    name: z.string().optional().describe('Display name; defaults to the file name'),
  }),
  consent: ['read-path'],
  consentPaths: ({ path: filePath }) => [{ path: filePath, accepts: MEDIA_EXTENSIONS }],
  handler: async ({ path: filePath, name }) => {
    const asset = await importMediaFromPath(filePath, name);
    return {
      assetId: asset.id,
      name: asset.name,
      type: asset.type,
      durationMs: asset.durationMs,
      ...(asset.width ? { dimensions: `${asset.width}×${asset.height}` } : {}),
      decoded: asset.decoded,
      ...(asset.decoded
        ? {}
        : {
            warning:
              `Nothing could decode this file: ${asset.undecodableReason}. It is in the media ` +
              'pool, but durationMs is a 5s placeholder rather than a measurement. Run it ' +
              'through ffmpeg_process to transcode it, or check the path.',
          }),
    };
  },
});


/**
 * Nine operations, plus one that is never exposed.
 *
 * `custom` stays defined and callable in-process — the panel's own chat
 * is a different trust boundary — and is absent from `EXPOSED_OPERATIONS`
 * below, which is what the manifest advertises and what the bridge
 * validates against. See `exposedSchema` on `KerfTool`.
 */
const FFMPEG_OPERATIONS = [
  'stabilize', 'interpolate', 'denoise', 'sharpen', 'deflicker',
  'reverse', 'speed', 'lut', 'extract_audio', 'custom',
] as const;

const EXPOSED_OPERATIONS = FFMPEG_OPERATIONS.filter((op) => op !== 'custom') as unknown as
  [typeof FFMPEG_OPERATIONS[number], ...Array<typeof FFMPEG_OPERATIONS[number]>];

const ffmpegShape = {
  source: z.string().optional()
    .describe('Clip id, media asset id or name, or an absolute path. Defaults to the selected clip.'),
  fps: z.number().optional().describe('Target rate for "interpolate"'),
  amount: z.number().optional().describe('0..100 strength, where the operation takes one'),
  speed: z.number().optional().describe('Multiplier for "speed"; 0.5 is half, 2 is double'),
  lutPath: z.string().optional().describe('Absolute path to a .cube file for "lut"'),
  replaceClip: z.boolean().optional()
    .describe('Point the source clip at the processed file instead of only importing it'),
};

const FFMPEG_DESCRIPTION =
  'Pre-render a media file through ffmpeg and import the result as a new asset. This is how the ' +
  'editor does what the real-time compositor cannot: stabilise shaky footage, interpolate to a ' +
  'higher frame rate, denoise, reverse, apply a .cube LUT. It writes a NEW file and leaves the ' +
  'original untouched. Slower than real time on long clips — say so before starting one. The ' +
  'operator is asked before it runs, and asked once per session about running ffmpeg at all.';

defineTool({
  name: 'ffmpeg_process',
  category: 'media',
  description: FFMPEG_DESCRIPTION,
  schema: z.object({
    ...ffmpegShape,
    operation: z.enum(FFMPEG_OPERATIONS),
    filtergraph: z.string().optional().describe('For operation "custom": a raw -vf filtergraph'),
    audioFiltergraph: z.string().optional().describe('For operation "custom": a raw -af filtergraph'),
  }),
  /* The enum a caller outside this renderer gets, and the reason the
     field exists at all. `filtergraph` goes with `custom`: advertising
     an argument that no exposed operation reads would be an invitation. */
  exposedSchema: z.object({ ...ffmpegShape, operation: z.enum(EXPOSED_OPERATIONS) }),
  /*
    Two capabilities, two scopes. Reading the input is per path; running
    ffmpeg is per session, because "may you read this" and "may you spend
    fifteen minutes of this machine" are different questions.
  */
  consent: ['read-path', 'spawn'],
  consentPaths: ({ source, lutPath }) => {
    const paths: RequestedPath[] = [];
    // Only an absolute path is a path. A clip id or an asset name refers
    // to media the operator already has, and gating those would prompt
    // for a file they imported themselves.
    if (source?.startsWith('/')) paths.push({ path: source, accepts: MEDIA_EXTENSIONS });
    if (lutPath) paths.push({ path: lutPath, accepts: LUT_EXTENSIONS });
    return paths;
  },
  consentDetail: ({ operation }) => `Operation "${operation}". ffmpeg can run for minutes.`,
  handler: async ({ source, operation, filtergraph, audioFiltergraph, fps, amount, speed, lutPath, replaceClip }) => {
    const api = (window as unknown as { teminali?: { media?: { ffmpeg?: (p: unknown) => Promise<{
      ok: boolean; path?: string; bytes?: number; error?: string;
    }> } } }).teminali?.media?.ffmpeg;
    if (!api) throw new Error('ffmpeg processing needs the desktop bridge.');

    const op = operation;
    const state = timeline();

    /* Resolve the source to a URL: a clip, a pool asset, or a path. */
    let input: string | null = null;
    let label = 'processed';
    let sourceClipId: string | null = null;

    if (source && /^(\/|file:|https?:)/.test(source)) {
      input = source;
      label = source.split('/').pop() ?? 'processed';
    } else {
      const clip = findClipById(state.tracks, resolveClipId(source));
      if (clip?.mediaUrl) {
        input = clip.mediaUrl;
        label = clip.name;
        sourceClipId = clip.id;
      } else if (source) {
        const asset = state.mediaPool.find((a) => a.id === source)
          ?? state.mediaPool.find((a) => a.name.toLowerCase().includes(source.toLowerCase()));
        if (asset) { input = asset.url; label = asset.name; }
      }
    }
    if (!input) throw new Error('No media source to process. Pass a clip id, an asset name, or an absolute path.');

    const strength = Math.max(0, Math.min(100, amount ?? 50)) / 100;
    let vf: string | undefined;
    let af: string | undefined;
    let audioOnly = false;
    let outFps: number | undefined;

    switch (op) {
      case 'stabilize': {
        /* libvidstab is not in every ffmpeg build; `deshake` is, and it
           needs no analysis pass. `rx`/`ry` MUST be multiples of 16 —
           ffmpeg accepts any value and then refuses to initialise with
           "Not yet implemented in FFmpeg, patches welcome", which names
           neither the filter nor the parameter. */
        const search = Math.max(16, Math.min(64, Math.round((16 + strength * 48) / 16) * 16));
        vf = `deshake=rx=${search}:ry=${search}:edge=3`;
        break;
      }
      case 'interpolate':
        outFps = fps ?? 60;
        vf = `minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`;
        break;
      case 'denoise':
        vf = `hqdn3d=${(strength * 8).toFixed(1)}:${(strength * 6).toFixed(1)}:${(strength * 12).toFixed(1)}:${(strength * 9).toFixed(1)}`;
        af = 'afftdn=nf=-25';
        break;
      case 'sharpen':
        vf = `unsharp=5:5:${(strength * 2).toFixed(2)}:5:5:0`;
        break;
      case 'deflicker':
        vf = 'deflicker=mode=pm:size=10';
        break;
      case 'reverse':
        vf = 'reverse';
        af = 'areverse';
        break;
      case 'speed': {
        const mult = Math.max(0.1, Math.min(10, speed ?? 2));
        vf = `setpts=${(1 / mult).toFixed(5)}*PTS`;
        /* atempo only spans 0.5..2.0 per stage, so a bigger change chains. */
        const stages: number[] = [];
        let remaining = mult;
        while (remaining > 2) { stages.push(2); remaining /= 2; }
        while (remaining < 0.5) { stages.push(0.5); remaining /= 0.5; }
        stages.push(remaining);
        af = stages.map((x) => `atempo=${x.toFixed(5)}`).join(',');
        break;
      }
      case 'lut': {
        if (!lutPath) throw new Error('operation "lut" needs `lutPath`, an absolute path to a .cube file.');
        vf = `lut3d=file='${lutPath.replace(/'/g, "\\'")}'`;
        break;
      }
      case 'extract_audio':
        audioOnly = true;
        break;
      case 'custom':
        if (!filtergraph && !audioFiltergraph) {
          throw new Error('operation "custom" needs `filtergraph` and/or `audioFiltergraph`.');
        }
        vf = filtergraph;
        af = audioFiltergraph;
        break;
    }

    const result = await api({ input, vf, af, fps: outFps, audioOnly, name: `${label}-${op}` });
    if (!result.ok || !result.path) throw new Error(`ffmpeg could not process it: ${result.error}`);

    const imported = await importMediaFromPath(result.path, `${label} (${op})`);

    if (replaceClip && sourceClipId) {
      asOneEdit(`Process ${label} (${op})`, () => state.patchClip(sourceClipId as string, { mediaUrl: imported.url }));
    }

    return {
      operation: op,
      outputPath: result.path,
      bytes: result.bytes,
      sizeMb: Number(((result.bytes ?? 0) / 1024 / 1024).toFixed(2)),
      assetId: imported.id,
      name: imported.name,
      durationMs: imported.durationMs,
      filtergraph: vf ?? af ?? '(none)',
      ...(replaceClip && sourceClipId ? { replacedClip: sourceClipId } : {}),
    };
  },
});

/* ═══════════════════════════════════════════════════════════════════
   CAPTIONS — generate, verify, and perfect subtitles in one shot
   ═══════════════════════════════════════════════════════════════════ */

const captionShape = {
  action: z.enum(['generate', 'verify', 'perfect', 'all']).optional()
    .describe('Operation: "generate" (from text/subtitles), "verify" (inspect timing/overlaps/overruns), "perfect" (clean/reflow/balance/fix), or "all" (complete workflow, default)'),
  subtitles: z.string().optional()
    .describe('Raw subtitle text in SRT, WebVTT, ASS, SBV or JSON format to parse and perfect'),
  text: z.string().optional()
    .describe('Plain transcript or script text to segment, balance, and time across the timeline'),
  clipId: z.string().optional()
    .describe('Id of a video or audio clip on the timeline to derive duration and alignment from'),
  trackId: z.string().optional()
    .describe('Text/caption track id to read from or place captions onto'),
  language: z.string().optional()
    .describe('Language code, e.g. "en", "sw", "fr", "es" (default "en")'),
  maxCharsPerLine: z.number().optional()
    .describe('Maximum characters per line (default 42, standard broadcast limit)'),
  minDurationMs: z.number().optional()
    .describe('Minimum display duration per cue in ms (default 300ms)'),
  offsetMs: z.number().optional()
    .describe('Time shift in ms to sync audio with captions (+ to delay, - to advance)'),
  stylePreset: z.enum(['broadcast', 'kinetic', 'minimal']).optional()
    .describe('Visual styling preset for timeline caption clips (default "broadcast")'),
  replaceExisting: z.boolean().optional()
    .describe('Replace existing clips on the target caption track (default true)'),
  applyToTimeline: z.boolean().optional()
    .describe('Whether to apply perfected captions directly to the video timeline (default true)'),
};

function captionContext() {
  const state = timeline();
  return {
    getTimelineCues: (trackId?: string) => {
      const track = trackId
        ? state.tracks.find((t) => t.id === trackId)
        : state.tracks.find((t) => t.type === 'text' || /caption|subtitle/i.test(t.name));
      if (!track || track.clips.length === 0) return null;
      const sortedClips = [...track.clips].sort((a, b) => a.startTimeMs - b.startTimeMs);
      const cues = sortedClips.map((c, i) => ({
        index: i + 1,
        startMs: c.startTimeMs,
        endMs: c.startTimeMs + c.durationMs,
        text: c.textStyle?.text ?? c.name,
        align: c.textStyle?.align ?? 'center',
      }));
      return { trackId: track.id, cues };
    },
    importCaptions: (cues: any, opts: any) => timeline().importCaptions(cues, opts),
    projectDurationMs: project().project?.durationMs || getContentEndMs(state.tracks) || 10000,
  };
}

defineTool({
  name: 'perfect_captions',
  category: 'graphics',
  description:
    'Generate, verify, and perfect subtitles/captions on the video timeline. ' +
    'Parses SRT/VTT/ASS/JSON or plain text, verifies overlaps and line length limits (>42 chars), ' +
    'balances lines, enforces minimum readable duration, shifts sync offsets, and places formatted clips onto the timeline.',
  schema: z.object(captionShape),
  handler: (args) => {
    return asOneEdit('Perfect captions', () => runCaptionWorkflow(args, captionContext()));
  },
});

defineTool({
  name: 'generate_captions',
  category: 'graphics',
  description:
    'Generate timed, balanced subtitles from script text or subtitle files and place them on the video timeline.',
  schema: z.object(captionShape),
  handler: (args) => {
    return asOneEdit('Generate captions', () => runCaptionWorkflow({ ...args, action: args.action ?? 'generate' }, captionContext()));
  },
});


/* ── The recorder's build ───────────────────────────────────────────
   The tutorial skill. `assembleRecording` is what turns a raw take into
   a cut — zooms from the pointer track, the camera full-frame while the
   operator explains, narration detached, ticks and whooshes — and until
   now it ran only from the review screen's button. This is that button
   for an agent: the same store action and the same sticky settings, so
   the build an agent asks for is the build the operator would have got
   by clicking. It builds; it does not record. A take has to be waiting
   on the review screen, and the error says so when none is.

   `style` is a switch, not a preset dump. Omitted, the sticky settings
   stand as the operator left them; "tutorial" turns the auto edit ON
   with the defaults `TUTORIAL_ASSEMBLE` names, "raw" turns it OFF. The
   named overrides then win over either, and are remembered the way the
   review screen remembers them. */

defineTool({
  name: 'build_recording',
  category: 'project',
  description:
    'Build the take waiting on the recorder\'s review screen onto the timeline. Omit style ' +
    'to build with the operator\'s current settings; style:"tutorial" switches the auto edit ' +
    'on (zooms on the moments the pointer track found, camera full-frame while the operator ' +
    'is explaining, narration on its own track, cursor drawn, ticks and whooshes); ' +
    'style:"raw" lays screen and camera down untouched. The other flags override either and ' +
    'are remembered. Fails when nothing has been recorded — this builds, it cannot record. ' +
    'Returns the build report: clips, zooms, keyframes, notes.',
  schema: z.object({
    style: z.enum(['tutorial', 'raw']).optional().describe('"tutorial" or "raw"; omit to keep the operator\'s settings'),
    autoZoom: z.boolean().optional().describe('Zoom in on the moments the pointer track found'),
    drawCursor: z.boolean().optional().describe('Draw the pointer as its own layer'),
    cinematic: z.boolean().optional().describe('Opening and closing moves, dip to black'),
    sound: z.boolean().optional().describe('Ticks on clicks, whooshes on zooms'),
    detachNarration: z.boolean().optional().describe('Put the microphone on its own audio track'),
    includeCamera: z.boolean().optional().describe('Show the camera at all'),
    cameraOnExplaining: z.boolean().optional().describe('Camera full-frame while the operator is explaining'),
    markMoments: z.boolean().optional().describe('Drop a marker at every zoom moment'),
  }),
  handler: async (args) => {
    const recorder = useRecorderStore.getState();
    if (!recorder.take?.screen) {
      throw new Error(
        `No take is waiting to be built (the recorder is in "${recorder.phase}"). Record something ` +
        'first; this tool builds a take, it does not record one.',
      );
    }
    const preset = args.style === 'tutorial'
      ? {
        autoZoom: TUTORIAL_ASSEMBLE.autoZoom,
        drawCursor: TUTORIAL_ASSEMBLE.drawCursor,
        cinematic: TUTORIAL_ASSEMBLE.cinematic,
        sound: TUTORIAL_ASSEMBLE.sound,
        cameraOnExplaining: TUTORIAL_ASSEMBLE.cameraOnExplaining,
        markMoments: TUTORIAL_ASSEMBLE.markMoments,
      }
      : args.style === 'raw'
        ? { autoZoom: false, drawCursor: false, cinematic: false, sound: false, cameraOnExplaining: false, markMoments: false }
        : {};
    const apply = <K extends keyof StickySettings>(key: K, value: StickySettings[K] | undefined) => {
      if (value !== undefined) recorder.set(key, value);
    };
    apply('autoZoom', args.autoZoom ?? preset.autoZoom);
    apply('drawCursor', args.drawCursor ?? preset.drawCursor);
    apply('cinematic', args.cinematic ?? preset.cinematic);
    apply('sound', args.sound ?? preset.sound);
    apply('cameraOnExplaining', args.cameraOnExplaining ?? preset.cameraOnExplaining);
    apply('markMoments', args.markMoments ?? preset.markMoments);
    apply('detachNarration', args.detachNarration);
    apply('includeCamera', args.includeCamera);

    const report = await recorder.openOnTimeline();
    if (!report) throw new Error('The build did not land; the recorder has shown why.');
    return report;
  },
});

/* ═══════════════════════════════════════════════════════════════════
   EXECUTION
   ═══════════════════════════════════════════════════════════════════ */

export const KERF_TOOLS: readonly KerfTool[] = tools;

export function getTool(name: string): KerfTool | undefined {
  if (name === 'verify_captions') return tools.find((t) => t.name === 'perfect_captions');
  return tools.find((t) => t.name === name);
}

/* ── The exposed surface ────────────────────────────────────────────
   An ALLOWLIST, not `tools`, because the tool surface is the only part
   of this that costs tokens.

   Measured, not estimated: the Cut's 115 tool descriptions are 34,660
   characters (~8.7k tokens), and 15-20k once their JSON schemas go with
   them, since several carry long enums. The three below are ~900. That
   cost is paid on EVERY request that advertises the panel, and it is
   identical whichever transport carries the call — a function pointer
   in this renderer, an IPC hop, or the MCP shim's stdio pipe all move
   the same bytes past the model.

   So copy-pasting tool number four out of the Cut does not put it in
   front of a model: someone has to add its name here and accept the
   cost. The ceiling is deliberate, and a test asserts on it — the point
   of this file is three tools growing to maybe a dozen, never 115.
*/
export const TOOL_BUDGET = 15;

export const EXPOSED_TOOLS: readonly string[] = [
  'describe_timeline',
  'patch_clip',
  'set_effect_param',
  /* P3. Measured against P2's 912 characters of descriptions: these
     three take the total to ~1.8k and the whole manifest to roughly
     3.7k (~920 tokens), against a budget of 15 tools and the Cut's
     15-20k for all 115. Affordable, and each one is here because a
     human decided to pay for it. The two below `list_media_pool`
     declare `consent`, and a test asserts that no tool reaches this
     list with a consent it declares and the bridge does not check. */
  'list_media_pool',
  'import_media_from_path',
  'ffmpeg_process',
  'perfect_captions',
  'generate_captions',
  /* The tutorial skill, listed in the Skills catalogue as Tutorial
     Builder. No consent: it reads no path a caller names — the take it
     builds is the one the recorder already wrote. */
  'build_recording',
];

/**
 * Whether a tool may be reached from OUTSIDE this renderer.
 *
 * The in-renderer chat and the MCP bridge are not the same trust
 * boundary. A tool that is merely un-advertised is still callable by a
 * client that knows its name, and the tools this file will grow next
 * are import and export — the two that touch the user's disk and want
 * an approval gate first. The bridge checks this; `executeTool` does
 * not, so the panel's own code can still call anything defined here.
 */
export function isExposed(name: string): boolean {
  return EXPOSED_TOOLS.includes(name);
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
}

export interface ExecuteOptions {
  /**
   * True when the caller is outside this renderer.
   *
   * It selects `exposedSchema` where a tool has one, which is what keeps
   * `ffmpeg_process`'s `custom` operation callable by the panel's own
   * chat and unreachable over MCP. It does NOT check the allowlist or
   * the gate: `services/videoToolBridge.ts` owns both, because they are
   * questions about the transport, not about the tool.
   */
  external?: boolean;
}

/** Validate and execute a tool call. Never throws. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  agentName = 'External Agent',
  options: ExecuteOptions = {}
): Promise<ToolResult> {
  const started = performance.now();
  const tool = getTool(name);

  if (!tool) {
    const suggestion = tools
      .map((t) => t.name)
      .filter((t) => t.includes(name.split('_')[0]))
      .slice(0, 3);
    const error = `Unknown tool "${name}".${suggestion.length ? ` Did you mean: ${suggestion.join(', ')}?` : ''}`;
    return { success: false, error, durationMs: 0 };
  }

  const schema = options.external ? tool.exposedSchema ?? tool.schema : tool.schema;
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const error = `Invalid arguments for ${name}: ${parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}, ${i.message}`)
      .join('; ')}`;
    return { success: false, error, durationMs: 0 };
  }

  try {
    const data = await tool.handler(parsed.data, { agentName });
    return { success: true, data, durationMs: Math.round(performance.now() - started) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error, durationMs: Math.round(performance.now() - started) };
  }
}

/**
 * JSON-Schema style listing for an MCP `tools/list` response.
 *
 * Curated by default — see EXPOSED_TOOLS for why. `{ all: true }` lists
 * everything defined, which is for looking at the file's contents, not
 * for handing to a model.
 */
export function getToolManifest(options: { all?: boolean } = {}) {
  const listed = options.all ? KERF_TOOLS : KERF_TOOLS.filter((t) => isExposed(t.name));
  return listed.map((t) => ({
    name: t.name,
    description: t.description,
    category: t.category,
    // The narrowed schema where a tool has one, so the manifest states
    // what the bridge will actually accept rather than what the chat can.
    inputSchema: zodToJsonSchema(t.exposedSchema ?? t.schema),
  }));
}

/** Minimal Zod → JSON Schema conversion covering the shapes used here. */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as any)._def;

  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }

  if (schema instanceof z.ZodOptional) {
    return { ...zodToJsonSchema(def.innerType), optional: true };
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema(def.type) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: def.values };
  }
  if (schema instanceof z.ZodRecord) {
    return { type: 'object', additionalProperties: true };
  }
  /*
    Unions convert to `anyOf`. Without this branch a union fell through
    to `{}` — the same empty schema `z.any()` produced, which is what
    made `set_effect_param.value` the one untyped property in the Cut's
    whole tool surface. Typing it with a union and NOT adding this would
    have changed nothing while looking like a fix.
  */
  if (schema instanceof z.ZodUnion) {
    return { anyOf: (def.options as z.ZodTypeAny[]).map((o) => zodToJsonSchema(o)) };
  }
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodString) {
    return { type: 'string', ...(def.description ? { description: def.description } : {}) };
  }
  return {};
}
