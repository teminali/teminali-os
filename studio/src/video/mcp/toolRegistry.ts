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
import { useTimelineStore, findClipById, getContentEndMs } from '../store/timelineStore';
import { useProjectStore } from '../store/projectStore';
import { describeClipProperties } from '../engine/propertyPath';

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
   EXECUTION
   ═══════════════════════════════════════════════════════════════════ */

export const KERF_TOOLS: readonly KerfTool[] = tools;

export function getTool(name: string): KerfTool | undefined {
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

/** Validate and execute a tool call. Never throws. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  agentName = 'External Agent'
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

  const parsed = tool.schema.safeParse(args ?? {});
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
    inputSchema: zodToJsonSchema(t.schema),
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
