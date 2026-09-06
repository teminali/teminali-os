/* ═══════════════════════════════════════════════════════════════════
   Everything the recorder panel knows.

   The capture engine holds the MediaRecorders and the main process
   holds the files; this holds only what the interface has to draw, and
   it is the single place a recording can be started or stopped from.
   That matters more here than in most stores: a recording can be
   stopped from FOUR places — the panel, the floating bar, a global
   shortcut, and the app quitting — and every one of them has to land in
   the same code or a take gets half-written.

   Settings persist. Nobody wants to re-pick their microphone every
   time, and the source list is the only part that genuinely cannot be
   remembered (a window id is only valid for as long as that window is).

   ── Two kinds of setting, and why both are sticky ───────────────────
   Above `detachNarration` is what the CAPTURE does: fps, devices, the
   countdown. Those are final the moment the take stops. Below it is
   what the BUILD makes of the take — the zooms, the frame, the
   camera's choreography — and every one of those can be changed and
   the same files rebuilt. The panel splits them for that reason:
   capture setup asks the first set before recording, the review screen
   asks the second immediately before opening on the timeline.

   Both persist. A sticky setting nothing reads would be a promise the
   panel cannot keep, so each one arrived with the module that honours
   it; `openOnTimeline` is where they all land.
   ═══════════════════════════════════════════════════════════════════ */

import { create } from 'zustand';
import { useUiStore } from './uiStore';
import type {
  RecorderSource, RecorderPermissions, RecorderConvertProgress,
} from '../../types/recorder';
import {
  startCapture, stopCapture, pauseCapture, cancelCapture, listDevices, isRecording,
  onConvertProgress,
} from '../engine/screenCapture';
import type { CaptureSettings, DeviceOption, Take } from '../engine/screenCapture';
import { formatDuration } from '../utils/time';
/* The corner and the inset size belong to the assemble that acts on
   them, so the sticky settings take their shape and their defaults from
   there rather than keeping a second copy. */
import {
  assembleRecording, RAW_ASSEMBLE, TUTORIAL_ASSEMBLE,
  type AssembleOptions, type AssembleReport,
} from '../engine/recordingProject';
import { zoomStyleShape, type ZoomStyleId } from '../engine/cursorZoom';
import type { CameraShape } from '../engine/cameraChoreography';
import type { BackdropId } from '../engine/cinematicLook';
import type { CursorStyleId } from '../engine/cursorLayer';


export type RecorderPhase =
  | 'setup'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'processing'
  | 'review'
  | 'error';

/** The half of the settings that survives a restart. */
export interface StickySettings {
  fps: 30 | 60;
  maxWidth: number;
  cameraDeviceId: string | null;
  cameraHeight: 720 | 1080;
  mirrorCamera: boolean;
  micDeviceId: string | null;
  systemAudio: boolean;
  countdownSec: 0 | 3 | 5;
  hideWindow: boolean;
  /** Split the microphone off the camera clip, onto its own audio track. */
  detachNarration: boolean;
  cameraSizePct: number;
  cameraCorner: AssembleOptions['cameraCorner'];

  /* ── The auto edit ──────────────────────────────────────────────
     What the build INTERPRETS, as opposed to what the capture
     records. Remembered here rather than passed per build, because
     the answer is a matter of taste and does not change between
     takes. See `TUTORIAL_ASSEMBLE`.                              */

  /** Push the picture in on what was clicked, scrolled or typed. */
  autoZoom: boolean;
  /** Draw the pointer, which a macOS screen capture does not record. */
  drawCursor: boolean;
  /** Smear the zoom moves. Costs render time on every frame of the take. */
  motionBlur: boolean;
  /** Sit the picture on a backdrop, inset and rounded, and fade it up. */
  cinematic: boolean;
  /** Click ticks and zoom whooshes, on their own track. */
  sound: boolean;
  /** Drop a timeline marker on every moment the detector found. */
  markMoments: boolean;

  /* ── The look, and the camera's choreography ────────────────────
     Chosen on the review screen, immediately before the build, rather
     than in capture setup: none of it changes the FILES, so an
     operator who guessed wrong has a rebuild rather than a reshoot.
     They live here anyway, so the next take opens with the same
     answers already given.                                       */

  /** Which backdrop `cinematic` sets the picture on. */
  backdrop: BackdropId;
  /** Custom backdrop image URL or data URI. When set, overrides preset gradient. */
  backdropImage: string | null;
  /** Cursor pointer style. */
  cursorStyle: CursorStyleId;
  /** Inset padding percentage. */
  insetPct: number;
  /** Corner radius percentage. */
  cornerPct: number;
  /** How the zoom moves between framings — or `none`, which is no zooms. */
  zoomStyle: ZoomStyleId;
  /** Lay the camera down at all. Distinct from a take that has no camera. */
  includeCamera: boolean;
  /** What the inset is cut to: the whole frame, a rounded one, a square, a circle. */
  cameraShape: CameraShape;
  /** Move the inset to the other side when the pointer settles under it. */
  cameraDodge: boolean;
  /** Hand the camera the whole frame while the operator is explaining. */
  cameraOnExplaining: boolean;
}

const STORAGE_KEY = 'teminali.recorder.v1';

const isWin32 = typeof window !== 'undefined' && window.teminali?.platform === 'win32';

const DEFAULT_STICKY: StickySettings = {
  fps: 30,
  maxWidth: 0,
  cameraDeviceId: null,
  /* 1080p, not 720. A 720p camera cannot fill the frame without looking
     soft. `ideal` rather than `exact`, so a 720p webcam still works. */
  cameraHeight: 1080,
  mirrorCamera: true,
  micDeviceId: null,
  /* System audio loopback is supported natively on Windows; on macOS/Linux default to false so no false warnings appear */
  systemAudio: isWin32,
  countdownSec: 3,
  hideWindow: true,
  detachNarration: true,
  cameraSizePct: RAW_ASSEMBLE.cameraSizePct,
  cameraCorner: RAW_ASSEMBLE.cameraCorner,
  /*
    From `TUTORIAL_ASSEMBLE`, so the auto edit is ON out of the box.
    That is the product: a take that arrives already cut is the whole
    reason the detectors exist, and a user who wants the footage
    untouched has six switches and one build to reach it.
  */
  autoZoom: TUTORIAL_ASSEMBLE.autoZoom,
  drawCursor: TUTORIAL_ASSEMBLE.drawCursor,
  motionBlur: TUTORIAL_ASSEMBLE.motionBlur,
  cinematic: TUTORIAL_ASSEMBLE.cinematic,
  sound: TUTORIAL_ASSEMBLE.sound,
  markMoments: TUTORIAL_ASSEMBLE.markMoments,
  /* Also from `TUTORIAL_ASSEMBLE`, for the same reason. `zoomStyle` is
     the one that cannot be read off a field, because the assemble
     stores the SHAPE and this stores the name of it; `smooth` is the
     name of the shape it stores. */
  backdrop: TUTORIAL_ASSEMBLE.look.backdrop,
  backdropImage: null,
  cursorStyle: 'plane',
  insetPct: 88,
  cornerPct: 1.8,
  zoomStyle: 'smooth',
  includeCamera: TUTORIAL_ASSEMBLE.includeCamera,
  cameraShape: TUTORIAL_ASSEMBLE.cameraShape,
  cameraDodge: TUTORIAL_ASSEMBLE.cameraDodge,
  cameraOnExplaining: TUTORIAL_ASSEMBLE.cameraOnExplaining,
};

function loadSticky(): StickySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STICKY;
    const parsed = JSON.parse(raw) as Partial<StickySettings>;
    // If on non-Windows, ensure systemAudio defaults to false unless explicitly user-set
    const systemAudio = isWin32 ? (parsed.systemAudio ?? true) : Boolean(parsed.systemAudio);
    return { ...DEFAULT_STICKY, ...parsed, systemAudio };
  } catch {
    return DEFAULT_STICKY;
  }
}


function persistSticky(settings: StickySettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* A remembered microphone is not worth throwing during a render. */
  }
}

/** The recorder half of the preload bridge, or nothing in the browser build. */
function bridge() {
  return typeof window === 'undefined' ? undefined : window.teminali?.recorder;
}

interface RecorderState {
  isOpen: boolean;
  phase: RecorderPhase;

  sources: RecorderSource[];
  sourcesLoading: boolean;
  selectedSourceId: string | null;
  /** macOS says the permission is granted and hands back no displays. */
  screenGrantStale: boolean;

  permissions: RecorderPermissions | null;
  cameras: DeviceOption[];
  microphones: DeviceOption[];

  settings: StickySettings;

  countdown: number;
  elapsedMs: number;
  /**
   * Set when a recorder is producing nothing, within seconds of the
   * start rather than at the end. See the capture engine's watchdog.
   */
  fault: string | null;
  /** How many moments the user has marked during this take. */
  markCount: number;
  shortcuts: string[];

  take: Take | null;
  error: string | null;
  warnings: string[];
  /**
   * How far through the remux, or null when nothing is converting.
   *
   * Only ever set while the phase is `processing`; the review screen
   * has a take to talk about and does not need a bar.
   */
  convert: RecorderConvertProgress | null;

  open: () => void;
  close: () => void;

  refreshSources: () => Promise<void>;
  refreshDevices: (prompt?: boolean) => Promise<void>;
  refreshPermissions: () => Promise<void>;
  requestPermission: (kind: 'camera' | 'microphone' | 'screen' | 'accessibility') => Promise<void>;
  /** Clear the stale grant and restart, so macOS asks again. */
  repairScreenPermission: () => Promise<void>;

  selectSource: (id: string) => void;
  set: <K extends keyof StickySettings>(key: K, value: StickySettings[K]) => void;

  begin: () => Promise<void>;
  togglePause: () => Promise<void>;
  stop: () => Promise<void>;
  discard: () => Promise<void>;
  /** Mark a moment for the auto zoom. Goes through main, like the bar's. */
  mark: () => void;
  /** The echo coming back, which is what moves the counter. */
  noteMark: () => void;
  /**
   * Lay the reviewed take down on the timeline.
   *
   * Returns the build report, or `null` when there was nothing to
   * build — the caller uses that to decide whether to switch panels.
   * The take is left on disk and the phase is left in `review`, so a
   * build that the user did not like can simply be built again.
   */
  openOnTimeline: () => Promise<AssembleReport | null>;
}

let ticker: number | null = null;
let countdownTimer: number | null = null;

/** One id, so a fault from an earlier take cannot linger over a later one. */
const FAULT_TOAST = 'recorder-fault';

/** Push what the floating bar shows. Called on every tick and phase change. */
function publish(state: {
  phase: RecorderPhase; elapsedMs: number; markCount: number; fault?: string | null;
}): void {
  void bridge()?.publishState({
    phase: state.phase,
    elapsedMs: state.elapsedMs,
    markCount: state.markCount,
    /* The bar is the only thing on screen while the window is hidden, so
       a take that is recording nothing has to be visible THERE. */
    fault: state.fault ?? null,
  });
}

export const useRecorderStore = create<RecorderState>((set, get) => ({
  isOpen: false,
  phase: 'setup',

  sources: [],
  sourcesLoading: false,
  selectedSourceId: null,
  screenGrantStale: false,

  permissions: null,
  cameras: [],
  microphones: [],

  settings: loadSticky(),

  countdown: 0,
  elapsedMs: 0,
  fault: null,
  markCount: 0,
  shortcuts: [],

  take: null,
  error: null,
  warnings: [],
  convert: null,

  open: () => {
    set({
      isOpen: true, phase: 'setup', take: null, error: null,
      warnings: [], elapsedMs: 0, markCount: 0, fault: null, convert: null,
    });
    void get().refreshPermissions();
    void get().refreshSources();
    void get().refreshDevices();
  },

  close: () => {
    /*
      Closing the panel must never abandon a running take silently. The
      panel's own close button is disabled while recording; this is the
      belt for the Escape key and anything else that gets here.
    */
    if (isRecording()) return;
    if (ticker !== null) { window.clearInterval(ticker); ticker = null; }
    if (countdownTimer !== null) { window.clearInterval(countdownTimer); countdownTimer = null; }
    set({ isOpen: false, phase: 'setup' });
  },

  refreshSources: async () => {
    const api = bridge();
    if (!api) {
      const webSource: RecorderSource = {
        id: 'web:screen',
        name: 'Browser Display / Window / Tab',
        kind: 'screen',
        displayId: null,
        width: 1920,
        height: 1080,
        scaleFactor: 1,
        primary: true,
        thumbnail: null,
        icon: null,
      };
      set({
        sources: [webSource],
        sourcesLoading: false,
        selectedSourceId: 'web:screen',
      });
      return;
    }
    set({ sourcesLoading: true });
    const result = await api.sources(480);
    const sources = result.sources ?? [];
    set((s) => ({
      sources,
      sourcesLoading: false,
      screenGrantStale: Boolean(result.deniedDespiteSettings),
      error: result.ok ? s.error : (result.error ?? 'The screen list could not be read.'),
      // Keep the current pick if it still exists; otherwise take the primary display.
      selectedSourceId:
        s.selectedSourceId && sources.some((x) => x.id === s.selectedSourceId)
          ? s.selectedSourceId
          : (sources.find((x) => x.primary) ?? sources.find((x) => x.kind === 'screen') ?? sources[0])?.id ?? null,
    }));
  },

  refreshDevices: async (prompt = false) => {
    const isWeb = !bridge();
    const { cameras, microphones } = await listDevices(prompt || isWeb);
    set((s) => {
      const selectedCamera =
        s.settings.cameraDeviceId && cameras.some((c) => c.deviceId === s.settings.cameraDeviceId)
          ? s.settings.cameraDeviceId
          : (cameras[0]?.deviceId ?? null);
      const selectedMic =
        s.settings.micDeviceId && microphones.some((m) => m.deviceId === s.settings.micDeviceId)
          ? s.settings.micDeviceId
          : (microphones[0]?.deviceId ?? null);
      return {
        cameras,
        microphones,
        settings: {
          ...s.settings,
          cameraDeviceId: selectedCamera,
          micDeviceId: selectedMic,
        },
      };
    });
  },

  refreshPermissions: async () => {
    const api = bridge();
    if (api) {
      const permissions = await api.permissions();
      if (permissions) set({ permissions });
    } else {
      set({
        permissions: {
          platform: 'web',
          screen: 'granted',
          camera: 'granted',
          microphone: 'granted',
          barHiddenFromCapture: true,
          input: {
            ok: true,
            source: 'cursor-only',
            reason: 'ready',
            message: 'Web Browser Capture',
          },
        },
      });
    }
  },

  requestPermission: async (kind) => {
    const api = bridge();
    if (api) {
      await api.requestPermission(kind);
    } else if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      try {
        if (kind === 'camera') {
          const s = await navigator.mediaDevices.getUserMedia({ video: true });
          s.getTracks().forEach((t) => t.stop());
        } else if (kind === 'microphone') {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
        }
      } catch {
        /* dismissed prompt */
      }
    }
    await get().refreshPermissions();
    // Labels only appear once access has been granted at least once.
    await get().refreshDevices(true);
  },

  /*
    The switch is already on, so sending somebody back to System Settings
    would be sending them to look at a thing that is not the problem.
    Clearing the row is, and it needs a restart to take effect.
  */
  repairScreenPermission: async () => {
    const api = bridge();
    if (!api) return;
    const result = await api.resetScreenPermission();
    useUiStore.getState().pushToast({
      kind: result.ok ? 'success' : 'error',
      title: result.ok ? 'Restarting Teminali OS' : 'Could not reset the permission',
      detail: result.message,
      ttl: result.ok ? 2500 : 8000,
    });
    if (result.ok) window.setTimeout(() => void api.relaunch(), 1200);
  },

  selectSource: (id) => set({ selectedSourceId: id }),

  set: (key, value) =>
    set((s) => {
      const settings = { ...s.settings, [key]: value };
      persistSticky(settings);
      return { settings };
    }),

  begin: async () => {
    const state = get();
    /*
      Every path into this — the button, the keyboard, a second click on
      a button that has not repainted yet — has to be idempotent. Without
      this guard a double click ran two countdowns; the second reached
      `startCapture`, which correctly refused because one was already
      running, and the panel put the take that WAS recording into
      `error`.
    */
    if (state.phase === 'countdown' || state.phase === 'recording'
      || state.phase === 'paused' || state.phase === 'processing') {
      return;
    }
    const source = state.sources.find((s) => s.id === state.selectedSourceId);
    if (!source) {
      set({ error: 'Pick a screen or a window first.', phase: 'error' });
      return;
    }

    /*
      Resolves `false` when the countdown did not finish — which is the
      only thing that made the Cancel button on it mean anything. It set
      the phase back to `setup`, and then the countdown that was still
      running resolved anyway and started recording the screen of
      somebody who had just said no.
    */
    const runCountdown = (seconds: number) =>
      new Promise<boolean>((resolve) => {
        if (seconds <= 0) { resolve(true); return; }
        set({ phase: 'countdown', countdown: seconds });
        countdownTimer = window.setInterval(() => {
          if (get().phase !== 'countdown') {
            if (countdownTimer !== null) { window.clearInterval(countdownTimer); countdownTimer = null; }
            resolve(false);
            return;
          }
          const left = get().countdown - 1;
          set({ countdown: left });
          if (left <= 0) {
            if (countdownTimer !== null) { window.clearInterval(countdownTimer); countdownTimer = null; }
            resolve(true);
          }
        }, 1000);
      });

    if (!await runCountdown(state.settings.countdownSec)) return;
    /* And once more after the wait: the phase can have moved on while
       the last tick was in flight. */
    if (get().phase !== 'countdown' && state.settings.countdownSec > 0) return;

    const settings: CaptureSettings = {
      sourceId: source.id,
      sourceKind: source.kind,
      displayId: source.displayId,
      fps: state.settings.fps,
      maxWidth: state.settings.maxWidth,
      cameraDeviceId: state.settings.cameraDeviceId,
      cameraHeight: state.settings.cameraHeight,
      micDeviceId: state.settings.micDeviceId,
      systemAudio: state.settings.systemAudio,
      hideWindow: state.settings.hideWindow,
    };

    // Whatever the last take said, this one has not said it yet.
    useUiStore.getState().dismissToast(FAULT_TOAST);

    const outcome = await startCapture(settings, (fault) => {
      /*
        An empty message is the watchdog saying the chunks came back. It
        has to clear the sticky toast, or a take that stalled for six
        seconds and recovered carries "This take is not recording" for
        the rest of its length.
      */
      if (!fault) {
        set({ fault: null });
        publish({ phase: get().phase, elapsedMs: get().elapsedMs, markCount: get().markCount, fault: null });
        useUiStore.getState().dismissToast(FAULT_TOAST);
        return;
      }
      /*
        Raised from the capture engine six seconds in, not at the end.
        The alternative is what actually happened to somebody: twenty-
        seven seconds of recording, a green tick, and a zero-byte file.
      */
      set({ fault });
      publish({ phase: get().phase, elapsedMs: get().elapsedMs, markCount: get().markCount, fault });
      useUiStore.getState().pushToast({
        /* A fixed id, and sticky. Sticky because a take that is
           recording nothing is not something to miss while you look
           away; a fixed id so it replaces itself rather than stacking,
           and so the next take can clear it by name. */
        id: FAULT_TOAST,
        kind: 'error',
        title: 'This take is not recording',
        detail: fault,
        ttl: 0,
      });
    });
    if (!outcome.ok) {
      set({ phase: 'error', error: outcome.error ?? 'The capture could not be started.', warnings: outcome.warnings });
      return;
    }

    set({
      phase: 'recording',
      elapsedMs: 0,
      markCount: 0,
      fault: null,
      warnings: outcome.warnings,
      shortcuts: outcome.shortcuts,
      error: null,
    });
    publish({ phase: 'recording', elapsedMs: 0, markCount: 0 });

    /*
      A wall clock rather than a counter of ticks. `setInterval` drifts,
      and a timer that reads 9:58 on a ten-minute take is the kind of
      small lie that makes everything beside it suspect.
    */
    const startedAt = performance.now();
    let pausedTotal = 0;
    let pausedAt: number | null = null;

    ticker = window.setInterval(() => {
      const current = get();
      if (current.phase === 'paused') {
        if (pausedAt === null) pausedAt = performance.now();
        return;
      }
      if (pausedAt !== null) { pausedTotal += performance.now() - pausedAt; pausedAt = null; }
      if (current.phase !== 'recording') return;

      const elapsedMs = Math.round(performance.now() - startedAt - pausedTotal);
      set({ elapsedMs });
      publish({ phase: 'recording', elapsedMs, markCount: current.markCount, fault: current.fault });
    }, 200);
  },

  togglePause: async () => {
    const phase = get().phase;
    if (phase !== 'recording' && phase !== 'paused') return;
    const next = phase === 'recording' ? 'paused' : 'recording';
    await pauseCapture(next === 'paused');
    set({ phase: next });
    publish({ phase: next, elapsedMs: get().elapsedMs, markCount: get().markCount });
  },

  stop: async () => {
    if (!isRecording()) return;
    /* The bar, the global shortcut and the panel button are three ways
       to press one thing, and `processing` is already the answer. */
    if (get().phase === 'processing') return;
    if (ticker !== null) { window.clearInterval(ticker); ticker = null; }
    set({ phase: 'processing', convert: null, isOpen: true });
    publish({ phase: 'processing', elapsedMs: get().elapsedMs, markCount: get().markCount });

    /*
      Subscribed for exactly as long as the convert lasts, and released
      in a `finally` so a take that fails does not leave a listener
      writing progress into the next recording's panel.
    */
    const unwatch = onConvertProgress((convert) => {
      if (get().phase === 'processing') set({ convert });
    });

    let result: Awaited<ReturnType<typeof stopCapture>>;
    try {
      result = await stopCapture();
    } catch (err) {
      /*
        The other door onto the same wedge. A throw out of the stop path
        leaves the capture session `finishing` and non-null, and from
        there nothing records again until the window is reloaded —
        start says one is already running, stop says this one is already
        finishing. `cancelCapture(false)` is what gives the session back;
        `false` keeps the files, because the take on disk is the take the
        operator recorded and losing it is not the price of a failed
        finish.
      */
      await cancelCapture(false).catch(() => undefined);
      result = { ok: false, error: (err as Error).message || 'The take could not be finished.' };
    } finally {
      unwatch();
    }

    if (!result.ok) {
      set({ phase: 'error', error: result.error, convert: null });
      return;
    }
    set({
      phase: 'review',
      take: result.take,
      warnings: result.take.warnings,
      elapsedMs: result.take.durationMs,
      convert: null,
    });
  },

  /*
    Two different things behind one word, and the difference is on
    purpose.

    Called while a take is RUNNING it throws the take away, files and
    all — that is what "stop and discard" means, and the partial file it
    deletes is one nobody wants. Called from the review screen it only
    returns to setup: the take is already written, and deleting ten
    minutes of somebody's work because they pressed the button next to
    the one they wanted is not a thing this should be able to do. The
    review screen's button says "Record again" for exactly that reason.
  */
  discard: async () => {
    if (ticker !== null) { window.clearInterval(ticker); ticker = null; }
    /*
      The countdown interval is deliberately NOT cleared here. It is the
      thing that resolves `runCountdown`, and killing it from outside
      leaves `begin` awaiting a promise nothing will ever settle. It
      stops itself on its next tick, because the phase this sets is not
      `countdown` any more.
    */
    if (isRecording()) await cancelCapture(true);
    set({ phase: 'setup', take: null, elapsedMs: 0, markCount: 0, error: null, warnings: [], fault: null });
  },

  /*
    Deliberately the same round trip the floating bar makes, rather than
    a local increment.

    Main owns the mark LIST, because main owns the clock the cursor track
    is stamped with. A panel button that bumped its own counter would
    show a mark that never reached the take — and the two clocks are a
    few milliseconds apart, so even writing the renderer's own timestamp
    would land the zoom on a slightly different frame than a shortcut
    press would.
  */
  mark: () => {
    void bridge()?.barCommand('mark');
  },

  noteMark: () => {
    const markCount = get().markCount + 1;
    set({ markCount });
    publish({ phase: get().phase, elapsedMs: get().elapsedMs, markCount });
  },

  /*
    Async only because of the sound. `prepareSoundKit` renders the ticks
    and the whooshes offline and writes them into the take directory
    before the store transaction opens; with `sound` off, nothing in the
    build awaits anything.
  */
  openOnTimeline: async () => {
    const take = get().take;
    if (!take?.screen) return null;

    const settings = get().settings;
    try {
      const report = await assembleRecording(take, {
        detachNarration: settings.detachNarration,
        cameraSizePct: settings.cameraSizePct,
        cameraCorner: settings.cameraCorner,
        mirrorCamera: settings.mirrorCamera,
        includeCamera: settings.includeCamera,
        cameraShape: settings.cameraShape,
        cameraDodge: settings.cameraDodge,
        cameraOnExplaining: settings.cameraOnExplaining,
        /*
          `none` is not a shape, it is the absence of the pass, so it
          turns the switch off rather than selecting a fourth curve.
          The shape still has to be a valid object: `assembleRecording`
          reads fields off it before it checks the switch.
        */
        autoZoom: settings.autoZoom && settings.zoomStyle !== 'none',
        zoomShape: zoomStyleShape(settings.zoomStyle),
        drawCursor: settings.drawCursor,
        cursorStyle: settings.cursorStyle,
        motionBlur: settings.motionBlur,
        markMoments: settings.markMoments,
        cinematic: settings.cinematic,
        look: {
          ...TUTORIAL_ASSEMBLE.look,
          backdrop: settings.backdrop,
          backdropImage: settings.backdropImage,
          insetPct: settings.insetPct,
          cornerPct: settings.cornerPct,
        },
        sound: settings.sound,

        soundOptions: TUTORIAL_ASSEMBLE.soundOptions,
      });
      /*
        The notes are the build's own account of what it had to give
        way on — a camera too small to hit the requested size, a
        narration track that could not be split. They are warnings
        about the EDIT, so they replace the capture's, which the
        review has already shown.
      */
      set({ warnings: report.notes });
      announce(report);
      return report;
    } catch (error) {
      useUiStore.getState().pushToast({
        kind: 'error',
        title: 'Could not open the take on the timeline',
        detail: error instanceof Error ? error.message : String(error),
        ttl: 8000,
      });
      return null;
    }
  },
}));

/* ── Saying what landed ─────────────────────────────────────────────
   The build is the moment the recorder hands over and disappears: the
   dialog closes and the video editor takes the screen. Without a word
   about it, an operator who was watching the review screen sees the
   panel they already had, and cannot tell a take that landed from one
   that quietly did nothing.

   The toasts go through the shared ui store rather than the dialog's
   own overlay, so they outlive the dialog and finish rendering inside
   the editor — which is where the thing they describe now is.        */

function announce(report: AssembleReport): void {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const bits = [
    `${formatDuration(report.durationMs)} · ${report.width}x${report.height}`,
    plural(report.clips, 'clip'),
  ];
  if (report.zoomMoments > 0) bits.push(plural(report.zoomMoments, 'zoom'));
  if (report.soundClips > 0) bits.push(plural(report.soundClips, 'sound'));
  if (report.narrationDetached) bits.push('narration split off');

  const toast = useUiStore.getState().pushToast;
  toast({ kind: 'success', title: 'Take is on the timeline', detail: bits.join(' · ') });

  /*
    Two, not all of them. The notes are advisory and a stack of them
    would bury the success line that says the take arrived; the rest
    stay on the recorder's warnings for the next review screen.
  */
  for (const note of report.notes.slice(0, 2)) {
    toast({ kind: 'info', title: 'About this take', detail: note, ttl: 9000 });
  }
}

/* ── The other three ways a take can be controlled ──────────────────
   The floating bar and the global shortcuts both arrive as one event,
   and both have to end up in the store actions above rather than in
   their own copy of the logic. Registered once, at module load, because
   the panel component is not mounted while the window is hidden — which
   is precisely when the bar is the only control there is.            */

if (typeof window !== 'undefined' && window.teminali?.recorder) {
  window.teminali.recorder.onCommand(({ action }) => {
    const store = useRecorderStore.getState();
    if (action === 'stop') void store.stop();
    else if (action === 'pause') void store.togglePause();
    else if (action === 'mark') store.noteMark();
  });
}

