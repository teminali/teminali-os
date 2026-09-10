/**
 * The player panel's video, when it is mpv's window rather than an element.
 *
 * The same shape as `browserView.ts`, deliberately and for the same reason: on
 * Windows and Linux the picture is a native window layered over this document,
 * so it cannot be positioned by CSS, nothing can be drawn on top of it, and the
 * pane's job is to measure a rectangle and report whether it may be drawn. The
 * measuring is not repeated here — `measureBrowserViewBounds`, `boundsEqual`
 * and `isOverlayOpen` are imported from that file, which already solved it.
 *
 * **This is not available everywhere, and that is the normal case.** A browser
 * build has no bridge at all. macOS has the bridge and refuses every call: a
 * process cannot embed another process's window there, so the Mac keeps the
 * `<video>` element until a linked `libmpv` exists (B0/B3 — see
 * `docs/MEDIA_LICENSING.md`). So every answer here is `{ ok: false, reason }`
 * rather than a throw, and the pane must be able to draw the reason.
 */

// The extension is not optional: this file is imported by `tests/mpv-view.test.mjs`
// under plain node, which resolves no extensions. It was a type-only import
// before — erased before node ever saw it — and became a real one here.
import { measureBrowserViewBounds, type BrowserViewBounds } from "./browserView.ts";

export type { BrowserViewBounds as MpvViewBounds };

/**
 * One track of the file, as mpv numbers it.
 *
 * `id` is mpv's own `sid` or `aid` and is the only handle that selects a
 * track: the pane's WebVTT blobs have nothing that means anything to the
 * engine. `label` is built in main (`trackLabel` in `mpvProcess.cjs`) by the
 * same rule the pane names a probed stream by, so the menu reads the same
 * whichever engine drew it.
 */
export interface MpvTrack {
  id: number;
  label: string;
  language: string | null;
  selected: boolean;
  /** A sidecar file mpv loaded itself, rather than a stream inside the video. */
  external: boolean;
}

/** Everything selectable in the file. Video tracks are not in the contract. */
export interface MpvTrackList {
  subtitles: MpvTrack[];
  audio: MpvTrack[];
}

/** What the engine says about itself, as mpv observes it changing. */
export interface MpvViewState {
  id: string;
  position?: number;
  duration?: number;
  paused?: boolean;
  /** What the file actually has, sidecars included. Replaces the pane's own list. */
  tracks?: MpvTrackList;
  /** The selected subtitle track by mpv's id; null when subtitles are off. */
  subtitleId?: number | null;
  /** The file ended. mpv is `--keep-open`, so it is still there, holding the last frame. */
  ended?: boolean;
  path?: string;
  title?: string;
  /** The engine is gone — crashed, exited, or given up. Sent once. */
  closed?: boolean;
  error?: string;
}

/** Always resolved. `ok: false` carries a sentence written for the operator. */
export interface MpvViewAnswer {
  ok: boolean;
  reason?: string;
  /** The panel already owned the engine; nothing was started. */
  existing?: boolean;
}

/**
 * One frame of mpv's picture, or why there is none.
 *
 * `image` is base64 JPEG with no data-URI prefix — the same word and the same
 * shape `PlayerFrameCapture` in `services/playerFrame.ts` carries, so the
 * answer travels from mpv to the agent without being renamed on the way. The
 * encoding is main's (`mpv-view:frame` in `electron/mpvView.cjs`): the frame
 * is a bitmap in another process and there is no element here to draw.
 */
export interface MpvFrameAnswer {
  ok: boolean;
  image?: string;
  reason?: string;
}

/** One action from the mirrored contract — the same object `playerControl.ts` sends. */
export interface MpvPlayerCommand {
  action: string;
  value?: unknown;
}

/**
 * What `mpvCommand` needs that the command itself does not carry.
 *
 * The file's tracks, so that `subtitles: "English"` can become an `sid`. They
 * are passed back from the pane rather than read in main at the moment of the
 * command because the pane already has them — mpv pushed them up as
 * `MpvViewState.tracks` — and a second `get_property` per command would be a
 * round trip to learn something already known. Main is still the only place
 * they are *made*; this is the same list coming home.
 */
export interface MpvCommandContext {
  subtitles?: MpvTrack[];
  audio?: MpvTrack[];
}

export interface MpvViewBridge {
  ensure(id: string): Promise<MpvViewAnswer>;
  setBounds(id: string, bounds: BrowserViewBounds, visible: boolean): void;
  load(id: string, filePath: string): Promise<MpvViewAnswer>;
  command(id: string, command: MpvPlayerCommand, context?: MpvCommandContext): Promise<MpvViewAnswer>;
  frame(id: string): Promise<MpvFrameAnswer>;
  destroy(id: string): void;
  onState(handler: (state: MpvViewState) => void): () => void;
}

/**
 * The rectangle mpv may fill: the pane, less the chrome drawn over it.
 *
 * **This is the one thing the element version never had to think about.** The
 * pane's controls float on the picture — a scrim, a title, a scrubber, all
 * `position: absolute` above a `<video>`, which works because both are the
 * same document and the stacking context decides. An embedded mpv is not in
 * this document: it is a native child window layered above the whole of it,
 * so a control drawn "over the video" is drawn *behind* it and cannot be seen.
 * `setIgnoreMouseEvents` on the container answers the clicks and says nothing
 * about the stacking — the button is reachable and invisible, which is worse
 * than either.
 *
 * So where mpv owns the picture the chrome stops hiding and stops floating:
 * the top and bottom bars keep their place in the document and mpv is handed
 * the band between them. The picture is smaller than the pane by exactly the
 * chrome, and nothing is ever drawn where it cannot be seen. A bar that is not
 * there yet insets nothing, and a band squeezed past nothing returns a zero
 * height — which `MpvView` reads as hide, the same as any other empty
 * rectangle.
 */
export function embeddedPictureBounds(
  surface: Element | null,
  chrome: { top?: Element | null; bottom?: Element | null } = {},
): BrowserViewBounds {
  const pane = measureBrowserViewBounds(surface);
  if (pane.width === 0 || pane.height === 0) return pane;

  let top = pane.y;
  let bottom = pane.y + pane.height;

  // Each bar may only ever eat into the band, never push past the far edge:
  // chrome taller than the pane leaves no picture, not an inverted one.
  const above = chrome.top?.getBoundingClientRect();
  if (above) top = Math.min(Math.max(top, Math.round(above.bottom)), bottom);
  const below = chrome.bottom?.getBoundingClientRect();
  if (below) bottom = Math.max(Math.min(bottom, Math.round(below.top)), top);

  return { x: pane.x, y: top, width: pane.width, height: Math.max(0, bottom - top) };
}

/**
 * The track the remembered language asks for, or null to leave mpv alone.
 *
 * The pane remembers a subtitle *label* and mpv selects by *id*, and the two
 * only meet once the engine has reported the file's tracks — which is after
 * the file is already playing in mpv's own choice of subtitle. So the pane
 * re-asks, and this is the whole of when it should.
 *
 * Null in three cases, each of which would otherwise be a bug rather than a
 * no-op. **Nothing remembered** — `null` is what the operator turning
 * subtitles off stored, and re-applying anything over it would turn them back
 * on every episode. **Nothing matching** — mpv's own choice is a better answer
 * than none, and inventing "the first track" is how a Swahili preference
 * becomes silent French. And **already selected** — the answer to this command
 * is a new `sid`, which comes back here as the next `selectedId`, so comparing
 * against what is on is what makes the exchange settle instead of repeat.
 *
 * A rule rather than four lines inside an effect because it is the only part
 * of that effect a test on this machine can reach: `canEmbedSpawned` is false
 * on darwin, so the effect itself never runs here.
 */
export function subtitleToRestore(
  preferred: string | null,
  tracks: MpvTrack[] | undefined,
  selectedId: number | null,
): MpvTrack | null {
  if (!preferred) return null;
  const wanted = tracks?.find((track) => track.label === preferred);
  if (!wanted || wanted.id === selectedId) return null;
  return wanted;
}

/**
 * The `sub-add` a dropped subtitle file becomes, or the sentence to show instead.
 *
 * This is the gap B4 left open. The pane's own subtitle path reads the bytes
 * that arrive with the gesture and builds a WebVTT blob, which works because a
 * `<video>` element will take a blob URL. mpv will not: it opens files by path,
 * and a renderer is never told where a dropped file is — `File.path` was
 * removed in Electron 44 and a blob URL is not a path. So while mpv held the
 * picture the operator was told to go and put the file beside the video, which
 * is a true sentence and a bad player.
 *
 * `webUtils.getPathForFile` is the way in, and it is already on the bridge as
 * `media.getPathForFile` — it exists because the media gate needs a human
 * gesture to produce an absolute path before anything may consent to one. A
 * subtitle dropped on the picture is exactly such a gesture, so this asks the
 * same question the file pane asks and gets the same kind of answer.
 *
 * A rule rather than a branch inside the pane because, like `subtitleToRestore`
 * above, it is the only part of this that a test on this machine can reach:
 * `canEmbedSpawned` is false on darwin, so the branch that calls it never runs
 * here. The refusals are values for the same reason — each is a sentence an
 * operator reads, and a sentence is worth a test.
 *
 * The label it returns is the one the pane remembers *and* the title mpv is
 * given, deliberately the same string: see `mpvCommand`'s `subtitle_file`.
 */
export function subtitleFileToLoad<TFile extends { name: string }>(
  file: TFile,
  getPathForFile?: ((file: TFile) => string | null) | null,
): { command: MpvPlayerCommand; label: string } | { refusal: string } {
  // No bridge at all: a browser build, or an Electron too old to have it. The
  // old sentence is still the honest answer, because the folder really is the
  // only way in from here.
  if (!getPathForFile) {
    return {
      refusal:
        "The engine drawing this picture reads subtitle files from the folder. Put this one beside the video, named after it, and reopen it.",
    };
  }
  // A bridge that answers null: the drop carried no real file — a browser's
  // synthetic `File`, or one already gone. Naming the file separates this from
  // the case above, where nothing was ever going to work.
  const path = getPathForFile(file)?.trim() ?? "";
  if (!path) {
    return { refusal: `${file.name} could not be found on disk, so the engine cannot open it.` };
  }
  const label = file.name.replace(/\.[^.]+$/, "");
  return { command: { action: "subtitle_file", value: { path, title: label } }, label };
}

/** The bridge, or null in a browser build — where there is no main process to ask. */
export function mpvViewBridge(): MpvViewBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { teminali?: { mpvView?: MpvViewBridge } }).teminali?.mpvView;
  return bridge ?? null;
}
