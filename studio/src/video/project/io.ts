/*
  Save and open, as two verbs the shell can call.

  This module is the only place that knows all three of: the format, the
  Electron transport and the editor's stores. `format.ts` deliberately knows
  none of them — it turns state into text and back — and `videoProjects.cjs`
  moves that text without parsing it. The wiring has to live somewhere, and a
  module is a better home than a component: the commands are driven from the
  native File menu, which fires whatever has focus, so there may be no video
  component mounted to hang them off.

  Both verbs report through the editor's own toasts. `Toasts` renders inside
  `VideoPane`, so the shell focuses that panel before calling either — a
  refusal nobody can see is the same as a silent failure.
*/

import { WorkspaceService } from '../../services/workspaceService';
import { useProjectStore } from '../store/projectStore';
import { useTimelineStore } from '../store/timelineStore';
import { useUiStore } from '../store/uiStore';
import {
  parseProject,
  serializeProject,
  unsaveableMedia,
  type VideoProjectState,
} from './format';

const toast = (
  kind: 'success' | 'error' | 'info',
  title: string,
  detail?: string,
): void => {
  useUiStore.getState().pushToast({ kind, title, detail });
};

/** The four slices, read straight off the two stores that own them. */
function currentState(): VideoProjectState {
  const timeline = useTimelineStore.getState();
  return {
    project: useProjectStore.getState().project,
    tracks: timeline.tracks,
    markers: timeline.markers,
    mediaPool: timeline.mediaPool,
  };
}

/**
 * The transport, or `null` in a browser build.
 *
 * Saving needs a folder dialog and a write to an arbitrary path, and a page
 * has neither. The refusal names the reason rather than failing quietly.
 */
function transport() {
  const bridge = window.teminali?.videoProjects;
  if (!bridge) {
    toast('error', 'Video projects need the desktop app', 'A browser tab cannot write a project folder.');
    return null;
  }
  return bridge;
}

/**
 * Records the project in the recent list without rebinding the workspace root.
 *
 * Never fails the operation it follows: the file is already on disk by the
 * time this runs, and a recent list that missed an entry is not worth turning
 * a successful save into an error.
 */
async function remember(dir: string): Promise<void> {
  try {
    await WorkspaceService.rememberProject(dir);
  } catch {
    /* the gateway may not be up; the project is saved either way */
  }
}

/**
 * Save Video Project.
 *
 * Asks for a directory the first time and reuses it afterwards, which is what
 * makes the accelerator a save rather than a Save As. `saveAs` forces the
 * dialog back.
 */
export async function saveVideoProject(options: { saveAs?: boolean } = {}): Promise<void> {
  const bridge = transport();
  if (!bridge) return;

  let state = currentState();

  // Refused before the dialog, not after it: a blob URL dies with the page, so
  // a project written with one in it is already broken when it is saved. Ask
  // for a folder first and the operator names a project that cannot be kept.
  const blocked = unsaveableMedia(state);
  if (blocked.length > 0) {
    toast(
      'error',
      'This project cannot be saved yet',
      `${blocked.slice(0, 3).join(', ')}${blocked.length > 3 ? `, +${blocked.length - 3} more` : ''} ` +
        'only exist in this tab. Export or re-import them first.',
    );
    return;
  }

  const store = useProjectStore.getState();
  let dir = options.saveAs ? null : store.projectDir;

  if (!dir) {
    const chosen = await bridge.chooseSaveDir(state.project.name || 'Untitled Project');
    if (chosen.canceled) return;
    if (!chosen.ok || !chosen.dir) {
      toast('error', 'Could not create that folder', chosen.error);
      return;
    }
    dir = chosen.dir;

    // Rename before serialising, not after writing. The folder the operator
    // just named IS the project's name, and the payload is built from `state`
    // — renaming afterwards touches only the store, so the file keeps the old
    // name and hands it straight back on the next open. That is exactly the
    // disagreement between the title bar and Finder this rename exists to
    // prevent; it just takes a round trip to become visible.
    if (chosen.name) {
      useProjectStore.getState().setProjectName(chosen.name);
      state = currentState();
    }
  }

  const written = await bridge.save(dir, `${JSON.stringify(serializeProject(state), null, 2)}\n`);
  if (!written.ok || !written.dir) {
    toast('error', 'Could not save the project', written.error);
    return;
  }

  useProjectStore.getState().setProjectDir(written.dir);

  await remember(written.dir);
  toast('success', 'Project saved', written.name);
}

/**
 * Open the project in `dir`, reporting through the editor's toasts.
 *
 * The verb the recent lists call, and what the menu's dialog resolves to: the
 * two differ only in where the directory came from. Returns whether the
 * timeline was actually replaced, so a caller that also moves the operator
 * somewhere can decide not to.
 *
 * Replaces the timeline in place. There is no "save your changes first"
 * prompt because nothing tracks whether the current timeline is dirty; that is
 * a real gap, stated here rather than implied by its absence.
 */
export async function openVideoProjectAt(dir: string): Promise<boolean> {
  const bridge = transport();
  if (!bridge) return false;

  const read = await bridge.read(dir);
  if (!read.ok || typeof read.json !== 'string') {
    toast('error', 'Could not open that project', read.error);
    return false;
  }

  const parsed = parseProject(read.json);
  if (!parsed.ok) {
    toast('error', 'Could not open that project', parsed.error);
    return false;
  }

  // All four slices, across both stores. `loadProject` owns tracks, markers
  // and the pool together; the settings are the project store's.
  useProjectStore.getState().loadProjectSettings(parsed.file.project);
  useTimelineStore.getState().loadProject(parsed.file.tracks, parsed.file.markers, parsed.file.mediaPool);
  useProjectStore.getState().setProjectDir(dir);

  await remember(dir);
  toast('success', 'Project opened', parsed.file.project.name || dir.split('/').filter(Boolean).pop());
  return true;
}

/** Open Video Project — the menu's verb, which asks for the directory first. */
export async function openVideoProject(): Promise<void> {
  const bridge = transport();
  if (!bridge) return;

  const chosen = await bridge.chooseOpenDir();
  if (chosen.canceled) return;
  if (!chosen.ok || !chosen.dir) {
    toast('error', 'Could not open that folder', chosen.error);
    return;
  }

  await openVideoProjectAt(chosen.dir);
}

/* ── Auto-save & session recovery ────────────────────────────────── */

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let autoSaveUnsubs: Array<() => void> = [];

export function initAutoSave(): () => void {
  autoSaveUnsubs.forEach((unsub) => unsub());
  autoSaveUnsubs = [];

  const trigger = () => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      const bridge = window.teminali?.videoProjects;
      if (!bridge) return;
      const state = currentState();
      if (unsaveableMedia(state).length > 0 || state.tracks.length === 0) return;

      const serialized = serializeProject(state);
      const jsonStr = `${JSON.stringify(serialized, null, 2)}\n`;
      const dir = useProjectStore.getState().projectDir || undefined;

      await bridge.saveAutoSave(jsonStr, dir).catch(() => {});
      if (dir) {
        await bridge.save(dir, jsonStr).catch(() => {});
      }
    }, 1000);
  };

  const unsub1 = useTimelineStore.subscribe(trigger);
  const unsub2 = useProjectStore.subscribe(trigger);
  autoSaveUnsubs = [unsub1, unsub2];

  return () => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveUnsubs.forEach((unsub) => unsub());
    autoSaveUnsubs = [];
  };
}

export async function restoreAutoSave(): Promise<boolean> {
  const bridge = window.teminali?.videoProjects;
  if (!bridge) return false;

  if (useTimelineStore.getState().tracks.length > 0) return false;

  try {
    const res = await bridge.getAutoSave();
    if (!res || !res.ok || !res.json) return false;

    const parsed = parseProject(res.json);
    if (!parsed.ok) return false;

    useProjectStore.getState().loadProjectSettings(parsed.file.project);
    useTimelineStore.getState().loadProject(parsed.file.tracks, parsed.file.markers, parsed.file.mediaPool);
    if (res.dir) {
      useProjectStore.getState().setProjectDir(res.dir);
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearAutoSave(): Promise<void> {
  const bridge = window.teminali?.videoProjects;
  if (!bridge) return;
  await bridge.clearAutoSave().catch(() => {});
}

