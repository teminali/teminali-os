/*
  The video project file: what a directory has to contain to be one.

  The editor had no save format at all. Nothing on disk was a "video project",
  so neither list this feature adds had anything to classify — which is why the
  format comes first and the lists come after it.

  ── Why a saved project is machine-local ──────────────────────────────────────

  A clip points at its media through `clip.mediaUrl`, a plain URL string, and
  there are exactly two shapes it ever has:

    file://<absolute path>   imported media (`mcp/toolRegistry.ts` importMedia)
                             and every take recorded under Electron, where
                             `electron/screenRecorder.cjs` returns `fileUrl(path)`
    blob:...                 takes recorded in a plain browser only
                             (`engine/screenCapture.ts`, the `isWeb` branch)

  Nothing copies the bytes anywhere. So a `file://` reference is an absolute
  path to somewhere else on this machine, and a saved project moved to another
  machine opens with every clip pointing at nothing. That is a real limit, it is
  stated here rather than discovered later, and `version` is what a future
  format that copies media into the directory will step.

  A `blob:` URL is worse than machine-local: it dies when the page reloads, so
  writing one into a file would produce a project that is already broken at the
  moment it is saved. `unsaveableMedia` finds those and the save refuses instead
  — a refusal an operator can act on beats a file that silently opens empty.
*/

import type { MediaAsset, ProjectSettings, TimelineMarker, Track } from '../types/edl';

/**
 * The marker. A directory is a video project when it holds `project.json`
 * whose `kind` is this string.
 *
 * `studio/server/projects.js` classifies recent entries against the same
 * literal and cannot import this module — it is Node ESM on the other side of
 * the renderer boundary — so `studio/tests/video-project-format.test.mjs` reads
 * both files and asserts they still agree.
 */
export const VIDEO_PROJECT_KIND = 'teminali-video-project';

/** Stepped when a load written by this version would misread an older file. */
export const VIDEO_PROJECT_VERSION = 1;

/** The file the marker lives in, at the root of the project directory. */
export const VIDEO_PROJECT_FILE = 'project.json';

/**
 * The four slices that make up a project.
 *
 * `mediaPool` is here because `loadProject(tracks, markers)` does NOT restore
 * it: a project reloaded without its pool has clips that still play — they
 * carry their own `mediaUrl` — over a media library that has gone empty.
 */
export interface VideoProjectFile {
  kind: typeof VIDEO_PROJECT_KIND;
  version: number;
  /** ISO 8601, for the recent list to sort and show. */
  savedAt: string;
  project: ProjectSettings;
  tracks: Track[];
  markers: TimelineMarker[];
  mediaPool: MediaAsset[];
}

export interface VideoProjectState {
  project: ProjectSettings;
  tracks: Track[];
  markers: TimelineMarker[];
  mediaPool: MediaAsset[];
}

/**
 * Media that cannot survive being written down, by the name an operator would
 * recognise. Empty means the project is safe to save.
 */
export function unsaveableMedia(state: VideoProjectState): string[] {
  const names = new Set<string>();
  for (const asset of state.mediaPool) {
    if (asset.url.startsWith('blob:')) names.add(asset.name || asset.url);
  }
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.mediaUrl?.startsWith('blob:')) names.add(clip.name || clip.mediaUrl);
    }
  }
  return [...names];
}

export function serializeProject(state: VideoProjectState): VideoProjectFile {
  return {
    kind: VIDEO_PROJECT_KIND,
    version: VIDEO_PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    project: state.project,
    tracks: state.tracks,
    markers: state.markers,
    mediaPool: state.mediaPool,
  };
}

export type ParseResult =
  | { ok: true; file: VideoProjectFile }
  | { ok: false; error: string };

/**
 * Reads a `project.json` back.
 *
 * Deliberately shallow: it checks the marker, the version and the shape of the
 * four slices, and does not walk every clip. A file this app wrote is correct
 * by construction, and a file it did not write fails at the marker — the case
 * in between, a hand-edited project, is not worth a schema the format would
 * then have to keep in step by hand.
 */
export function parseProject(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That project file is not valid JSON.' };
  }

  const data = raw as Partial<VideoProjectFile> | null;
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'That project file is empty.' };
  }
  if (data.kind !== VIDEO_PROJECT_KIND) {
    return { ok: false, error: 'That folder holds a project.json, but not a Teminali video project.' };
  }
  if (typeof data.version !== 'number' || data.version > VIDEO_PROJECT_VERSION) {
    return {
      ok: false,
      error: `That project was saved by a newer version of Teminali Code (format ${String(data.version)}).`,
    };
  }
  if (!data.project || typeof data.project !== 'object') {
    return { ok: false, error: 'That project file has no project settings.' };
  }
  if (!Array.isArray(data.tracks)) {
    return { ok: false, error: 'That project file has no tracks.' };
  }

  return {
    ok: true,
    file: {
      kind: VIDEO_PROJECT_KIND,
      version: data.version,
      savedAt: typeof data.savedAt === 'string' ? data.savedAt : new Date().toISOString(),
      project: data.project as ProjectSettings,
      tracks: data.tracks as Track[],
      markers: Array.isArray(data.markers) ? (data.markers as TimelineMarker[]) : [],
      mediaPool: Array.isArray(data.mediaPool) ? (data.mediaPool as MediaAsset[]) : [],
    },
  };
}
