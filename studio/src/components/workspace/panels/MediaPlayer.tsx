import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ChevronLeft, ChevronRight, ChevronUp, FilePlus2, Gauge, Loader2, Maximize, Minimize, Pause, Play,
  PictureInPicture2, RotateCcw, RotateCw, SkipBack, SkipForward, Subtitles, Volume1, Volume2, VolumeX, X,
} from "lucide-react";
import { EmptyState } from "../../ui";
import { WorkspaceService } from "../../../services/workspaceService";
import {
  describeMediaError,
  formatDuration,
  probeWorkspaceMedia,
  readEmbeddedSubtitle,
  workspaceMediaBridge,
  workspaceMediaUrl,
  workspaceTranscodeUrl,
  type MediaProbeResult,
} from "../../../services/workspaceMedia";
import {
  isSubtitleFileName, subtitleToVtt, subtitleFileRefusal, type SubtitleTrack,
} from "../../../services/workspaceGallery";
import {
  clampRate, clampVolume, dispatchPlayerCommand, PLAYER_LIMITS, publishPlayerState, subscribePlayerCommands,
  type PlayerAction, type PlayerCommand, type PlayerEpisodeSummary, type PlayerSnapshot,
} from "../../../services/playerControl";
import { registerPlayerFrameSource } from "../../../services/playerFrame";
import { usePlayerStore } from "../../../store/playerStore";
import { useStudioStore } from "../../../store/studioStore";
import { subtitleFileToLoad, subtitleToRestore, type MpvTrackList, type MpvViewState } from "../../../services/mpvView";
import { useMpvView } from "./useMpvView";

/**
 * The player.
 *
 * It replaced `controls` on a bare `<video>`, and the reason is not taste.
 * Chromium's control bar is a closed shadow tree: nothing outside it can read
 * whether the video is playing, nothing can press its buttons, and nothing can
 * add a row to its subtitle menu. Four things this pane owes the operator
 * needed exactly those — subtitles from a sidecar file, an embedded stream or
 * a file they hand it; a timeline that works while ffmpeg is transcoding,
 * where seeking means asking for a *new stream*; an agent that can press play,
 * which is `player_control`; and chrome that gets out of the way of the
 * picture, which a fixed grey strip below the video never did.
 *
 * ## The chrome is over the picture, and it leaves
 *
 * The video fills the pane and the controls float on it, on one flat scrim —
 * a fill, not a gradient, so the rule in DESIGN.md §1 holds on the one surface
 * whose background is unknown. Everything is drawn from `--player-*` tokens,
 * which are calibrated against black rather than against the app's greys,
 * because a bar tuned for `#181818` disappears over a snowfield. While a video
 * plays and the pointer is still, the chrome and the cursor both go; any
 * movement, any menu, and a pause bring them back. Audio keeps its chrome
 * always: there is nothing to get out of the way of.
 *
 * ## The two playback modes, and why the timeline is virtual
 *
 * `direct` is the old behaviour: the element is pointed at `teminali-media://`
 * and Chromium demuxes and seeks by byte range. `transcode` is for everything
 * Chromium cannot open — MKV, HEVC, ProRes, AVI, WMV. ffmpeg writes fragmented
 * MP4 into the response and the element plays a stream with no length and no
 * ranges: `duration` is `Infinity`, and `currentTime` is *how long this stream
 * has been playing*, not where in the film we are. So the pane keeps `offset`
 * — the second the current stream started at — and every position it shows,
 * publishes or seeks to is `offset + element.currentTime`. A seek reloads the
 * element at a new offset. `duration` comes from ffprobe, which read the
 * container's own header.
 *
 * ## Subtitles come from three places
 *
 * A sidecar file beside the video, a stream inside it, and — the one VLC has
 * that this lacked — a file the operator hands it, by dropping it on the
 * picture or picking it from the menu. That last one never touches the gateway:
 * the OS hands the renderer the file's bytes with the drag, so there is no
 * path to resolve, no workspace boundary to argue about, and a subtitle file
 * from anywhere on the disk works the way it does in every other player.
 *
 * ## What the agent sees
 *
 * Every state change publishes a `PlayerSnapshot` (services/playerControl.ts)
 * to the store and, throttled, to the gateway — discrete events immediately,
 * so an agent that just asked for a pause does not read the frame before it.
 * Commands arrive on the run's stream and land in `runCommand` below, which is
 * the same function the on-screen buttons and the keyboard call: there is one
 * implementation of "pause", not three that can drift.
 */

interface MediaPlayerProps {
  /** Workspace-relative path of the file playing. */
  path: string;
  kind: "video" | "audio";
  /** What to call it in the bar and in the snapshot. */
  title: string;
  /** Sidecar subtitles found beside the file in the tree. */
  sidecars?: SubtitleTrack[];
  /** Set when this is one episode of a series, for next/previous and the snapshot. */
  series?: {
    folder: string;
    title: string;
    index: number;
    count: number;
    episodes: PlayerEpisodeSummary[];
  };
  onNext?: () => void;
  onPrevious?: () => void;
  /** Back to the gallery. Absent for a lone file, which has nowhere to go back to. */
  onExit?: () => void;
  /** Where to start, in seconds. */
  startAt?: number;
}

interface LoadedTrack {
  label: string;
  language: string | null;
  /** An object URL holding the WebVTT text. */
  url: string;
  source: "sidecar" | "embedded" | "added";
}

/**
 * The actions an embedded mpv answers, rather than the pane.
 *
 * The rest of the contract stays here because it is not playback: `fullscreen`
 * is this pane's layout, and `next`, `previous`, `episode` and `episodes` are
 * the series it was handed, none of which mpv has ever heard of.
 *
 * `subtitles` and `audio_track` are in the set as of B4, and were not before.
 * The engine chooses a track by its own number, so the two of them are the
 * only actions that need to be told what the file has — `runCommand` sends the
 * engine's own `track-list` back with them as context, and the pane's WebVTT
 * tracks, which meant nothing to it, are not built at all while it is drawing.
 */
const ENGINE_ACTIONS = new Set<PlayerAction>([
  "play", "pause", "toggle", "restart",
  "seek", "seek_by", "frame_step", "frame_back", "chapter",
  "volume", "mute", "unmute", "rate",
  "subtitles", "audio_track",
]);

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
/** Long enough that a still pointer hides the bar mid-film, short enough not to be in the way. */
const IDLE_MS = 2600;

/*
  The version control floats in the window's bottom-right corner
  (`updates/VersionControl.tsx`: `fixed bottom-2 right-3`, 22px tall) and it is
  above everything a panel draws. The video editor's timeline already reserves
  that strip; this is the second pane to draw content that far down, and it
  reserves it the same way rather than moving shared chrome for one pane's
  sake. Only when windowed: a fullscreen element is rendered alone, so nothing
  of the app's is over it. If that offset changes, change this with it.
*/
const VERSION_BADGE_STRIP = 76;

function volumeGlyph(volume: number, muted: boolean) {
  if (muted || volume === 0) return VolumeX;
  return volume < 0.5 ? Volume1 : Volume2;
}

/** Format seconds as hh:mm:ss to match the clean cinematic player format. */
function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00:00";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(hours)}:${two(minutes)}:${two(rest)}`;
}

/** A control on the scrim. One shape, so the bar reads as one row of controls. */
const PlayerButton: React.FC<{
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
  large?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, disabled = false, active = false, large = false, children }) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    disabled={disabled}
    title={title}
    aria-label={title}
    className={`flex items-center justify-center rounded-full flex-shrink-0 transition-colors duration-ds ease-ds
      ${large ? "w-10 h-10" : "w-8 h-8"}
      ${active ? "text-accent" : "text-[var(--player-ink)]"}
      hover:bg-[var(--player-hover)] disabled:opacity-30 disabled:hover:bg-transparent`}
  >
    {children}
  </button>
);

export const MediaPlayer: React.FC<MediaPlayerProps> = ({
  path, kind, title, sidecars = [], series, onNext, onPrevious, onExit, startAt = 0,
}) => {
  const elementRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);

  const [probe, setProbe] = useState<MediaProbeResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [found, setFound] = useState<LoadedTrack[]>([]);
  /** Subtitle files the operator handed the player this session. */
  const [added, setAdded] = useState<LoadedTrack[]>([]);
  const [note, setNote] = useState<string | null>(null);

  /* The second the current stream begins at. Always 0 unless transcoding. */
  const [offset, setOffset] = useState(startAt);
  const [time, setTime] = useState(startAt);
  const [duration, setDuration] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [buffered, setBuffered] = useState(0);

  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [activeTrack, setActiveTrack] = useState<string | null>(null);
  /**
   * The file's tracks as the engine numbers them, where the engine has the
   * picture. Null until it has said — which it does as soon as it is asked, so
   * an empty menu here means an engine that could not be asked, and
   * `unsupported` says so rather than the menu going quietly blank.
   */
  const [engineTracks, setEngineTracks] = useState<MpvTrackList | null>(null);
  const [engineSubtitleId, setEngineSubtitleId] = useState<number | null>(null);
  const [menu, setMenu] = useState<"none" | "subtitles" | "rate">("none");
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Where the pointer is on the scrubber, 0–1, for the time bubble. */
  const [hover, setHover] = useState<number | null>(null);

  const remember = usePlayerStore((state) => state.remember);
  const preferredSubtitle = usePlayerStore((state) => state.subtitle);
  const setPreferredSubtitle = usePlayerStore((state) => state.setSubtitle);
  const autoplayNext = usePlayerStore((state) => state.autoplayNext);

  const bridge = useMemo(() => workspaceMediaBridge(), []);

  /* ── The other picture: mpv's window, where there is one ─────────────── */
  /*
    On Windows and Linux the video is not this element at all — it is a native
    window mpv draws into, layered over the document (see `useMpvView.ts` and
    DESIGN.md §3). Everything below still runs: the pane keeps the probe, the
    subtitles, the snapshot and every control, and only three things change —
    the element is not rendered, the commands go to the engine instead of to
    it, and the position comes back from it. On macOS and in a browser build
    `embedded` is false and none of that happens.

    The chrome stops floating when it does. A control drawn over an OS window
    is drawn behind it, so `embeddedPictureBounds` hands mpv the band between
    the bars and the bars stay put — which is why they are measured, and why
    the auto-hide is off.
  */
  const workspacePath = useStudioStore((state) => state.workspacePath);
  const workspaceRootConfirmed = useStudioStore((state) => state.workspaceRootConfirmed);
  const topChromeRef = useRef<HTMLDivElement | null>(null);
  const bottomChromeRef = useRef<HTMLDivElement | null>(null);

  /*
    mpv has no workspace root and no protocol handler: it takes a path on the
    disk. An unconfirmed root is not one — main resolves a relative path
    against whatever it was last told, and under a root the operator never
    opened the same relative path can name a different file. So until the
    gateway has spoken there is no path to hand over, and the element (whose
    own protocol handler makes the same refusal) keeps the picture.
  */
  const absolutePath = useMemo(() => {
    if (!workspaceRootConfirmed || !workspacePath) return null;
    return `${workspacePath.replace(/\/+$/, "")}/${path}`;
  }, [workspacePath, workspaceRootConfirmed, path]);

  const onEngineState = useCallback((state: MpvViewState) => {
    if (typeof state.position === "number") {
      setTime(state.position);
      setWaiting(false);
    }
    if (typeof state.duration === "number" && state.duration > 0) setDuration(state.duration);
    if (typeof state.paused === "boolean") setPlaying(!state.paused);
    if (typeof state.ended === "boolean") setEnded(state.ended);
    // The file's real tracks, and which of them is on. Kept verbatim rather
    // than merged into the pane's own list: while the engine holds the picture
    // this *is* the list, and two half-lists that had to be reconciled is
    // exactly what B3 published as unsupported instead of shipping.
    if (state.tracks) setEngineTracks(state.tracks);
    if (state.subtitleId !== undefined) setEngineSubtitleId(state.subtitleId);
    // mpv going away is the one state the pane cannot paper over: there is no
    // element behind it holding the last frame, so it is said out loud.
    if (state.closed) setFailure(state.error ?? "The player engine stopped.");
    else if (state.error) setNote(state.error);
  }, []);

  const embed = useMpvView({
    enabled: kind === "video",
    filePath: absolutePath,
    surfaceRef,
    topChromeRef,
    bottomChromeRef,
    onState: onEngineState,
  });

  // Only once it is embedded. Before that the refusal is the ordinary one —
  // this is a Mac, or a browser build — and the operator is not owed a notice
  // that the player they are looking at is the player they always had.
  useEffect(() => {
    if (embed.embedded && embed.reason) setNote(embed.reason);
  }, [embed.embedded, embed.reason]);

  const transcoding = (probe?.plan.mode === "remux" || probe?.plan.mode === "transcode") && !embed.embedded;
  const tracks = useMemo(() => [...added, ...found], [added, found]);

  /*
    The subtitle menu, from whichever engine is drawing the picture.

    On the element path these are the pane's own WebVTT tracks, which it built
    out of the sidecar files and the file's text streams. Where mpv holds the
    picture the pane builds none of them — mpv has the same sidecars open
    (`--sub-auto=exact`) and draws its own — and this is mpv's `track-list`
    instead. One list either way, so the menu, the snapshot and the agent all
    see exactly what can be turned on.
  */
  const subtitleRows = useMemo(() => (
    embed.embedded
      ? (engineTracks?.subtitles ?? []).map((track) => ({
        key: `sid-${track.id}`,
        label: track.label,
        // mpv's word for a sidecar is "external"; the menu's is "file", and
        // the menu's is the operator's.
        source: track.external ? "file" : "embedded",
      }))
      : tracks.map((track) => ({
        key: track.url,
        label: track.label,
        source: track.source === "sidecar" ? "file" : track.source,
      }))
  ), [embed.embedded, engineTracks, tracks]);
  const subtitleLabels = useMemo(() => subtitleRows.map((row) => row.label), [subtitleRows]);
  /*
    Which one is on. While embedded that is mpv's answer and not the pane's:
    the same rule as position — the engine reports the state it actually has,
    and a local guess that disagreed would be a menu tick over a subtitle that
    is not on screen.
  */
  const activeSubtitle = useMemo(() => {
    if (!embed.embedded) return activeTrack;
    return engineTracks?.subtitles.find((track) => track.id === engineSubtitleId)?.label ?? null;
  }, [embed.embedded, engineTracks, engineSubtitleId, activeTrack]);

  /*
    The remembered language, applied to the engine's own list.

    The element path already does this, when its tracks finish loading: the
    whole point of remembering a language is that the next episode comes back
    in it. mpv chooses by its own rule instead — `--sub-auto` and whatever the
    file marks default — so without this the preference is honoured on one
    engine and quietly ignored on the other, which is the kind of difference
    that reads as the setting being broken rather than as two engines.

    The guard is `engineSubtitleId` itself, not a ref or a "have I sent this"
    flag. mpv answers this command by changing `sid`, which arrives back here
    as a new `engineSubtitleId`; comparing against what is *already selected*
    is what makes that a settling loop rather than a running one. Two things
    are deliberately left alone: a preference no track matches, because mpv's
    own choice beats no subtitles, and `null`, which is what the operator
    turning subtitles off stored and must not be undone on the next episode.
  */
  useEffect(() => {
    if (!embed.embedded) return;
    const wanted = subtitleToRestore(preferredSubtitle, engineTracks?.subtitles, engineSubtitleId);
    if (!wanted) return;
    embed.command({ action: "subtitles", value: wanted.label }, {
      subtitles: engineTracks?.subtitles ?? [],
      audio: engineTracks?.audio ?? [],
    });
  }, [embed, preferredSubtitle, engineTracks, engineSubtitleId]);

  /*
    What the element is pointed at.

    Rebuilt whenever the offset changes, because in a transcode that is the
    only way to seek — there is no file behind the URL to range-request. In
    direct mode the offset never moves and this is one URL for the whole file.
  */
  const source = useMemo(() => {
    if (!bridge) return null;
    if (transcoding) return workspaceTranscodeUrl(bridge, path, offset);
    return workspaceMediaUrl(bridge, path);
  }, [bridge, path, transcoding, offset]);

  /* ── What is in the file ────────────────────────────────────────────── */
  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    setProbe(null);
    setOffset(startAt);
    setTime(startAt);
    setEnded(false);
    probeWorkspaceMedia(path, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setProbe(result);
      if (result?.probe?.duration) setDuration(result.probe.duration);
      if (result?.plan.mode === "unplayable") setFailure(result.plan.reason);
    });
    return () => controller.abort();
    // `startAt` is the resume point, read once per file; a later change to it
    // is the operator seeking, which must not re-probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  /* ── The subtitle tracks the file came with ─────────────────────────── */
  useEffect(() => {
    /*
      Not while mpv holds the picture. It has the same sidecars open and the
      file's own streams besides, and it draws them itself — so building a
      second copy would cost an ffmpeg run per embedded stream to produce
      WebVTT that nothing in the window can display. The menu comes from its
      `track-list` instead (`subtitleLabels` above).
    */
    if (embed.embedded) return;
    let alive = true;
    const urls: string[] = [];

    const load = async () => {
      const loaded: LoadedTrack[] = [];

      // Sidecars first: they are a file the operator can see and edit, so when
      // one and an embedded stream carry the same name, theirs wins.
      for (const sidecar of sidecars) {
        try {
          const file = await WorkspaceService.readFile(sidecar.path);
          if (file.encoding !== "utf8") continue;
          const url = URL.createObjectURL(new Blob([subtitleToVtt(file.content, sidecar.path)], { type: "text/vtt" }));
          urls.push(url);
          loaded.push({ label: sidecar.label, language: sidecar.language, url, source: "sidecar" });
        } catch {
          /* A sidecar that will not read is one row missing from a menu, not a failed film. */
        }
      }

      for (const stream of probe?.probe?.subtitles ?? []) {
        if (!stream.text) continue; // PGS and DVD subtitles are pictures; ffmpeg cannot write them as text
        const label = stream.title || (stream.language ? stream.language.toUpperCase() : `Track ${stream.stream + 1}`);
        if (loaded.some((track) => track.label.toLowerCase() === label.toLowerCase())) continue;
        const vtt = await readEmbeddedSubtitle(path, stream.stream);
        if (!vtt || !alive) continue;
        const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
        urls.push(url);
        loaded.push({ label, language: stream.language, url, source: "embedded" });
      }

      if (!alive) {
        for (const url of urls) URL.revokeObjectURL(url);
        return;
      }
      setFound(loaded);
      // The language the operator last chose comes back on the next episode,
      // which is the whole point of remembering it.
      const wanted = loaded.find((track) => track.label === preferredSubtitle);
      if (wanted) setActiveTrack(wanted.label);
    };

    void load();
    return () => {
      alive = false;
      for (const url of urls) URL.revokeObjectURL(url);
      setFound([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, probe, embed.embedded]);

  /* A subtitle file the operator added is theirs for the session, and its URL is ours to free. */
  useEffect(() => () => {
    for (const track of added) URL.revokeObjectURL(track.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A subtitle file the operator handed us, by drop or from the picker.
   *
   * The bytes arrive with the gesture, so nothing is resolved, fetched or
   * guarded: a `.srt` on the Desktop works exactly as one inside the project
   * does, which is what every other player on the machine does and what this
   * one conspicuously did not. A format we cannot convert is named rather than
   * silently ignored.
   *
   * Where mpv holds the picture the same gesture takes a different road. What
   * arrives with the drop is bytes, and mpv opens files by path — so the path
   * is asked for by `subtitleFileToLoad`, through the media gate's
   * `getPathForFile`, and mpv is handed a `sub-add`. Nothing here goes looking
   * on the disk: the only path this pane can learn is the one the operator's
   * own gesture produced.
   */
  const addSubtitleFile = useCallback(async (file: File) => {
    setNote(null);
    // Ahead of the engine fork rather than inside each arm. mpv will accept
    // `sub-add` on anything and then show an empty track, so a format we cannot
    // name is refused once, in the same words, whichever engine has the picture.
    if (!isSubtitleFileName(file.name)) {
      setNote(subtitleFileRefusal(file.name));
      return;
    }
    if (embed.embedded) {
      const media = (window.teminali as unknown as {
        media?: { getPathForFile?: (file: File) => string | null };
      } | undefined)?.media;
      const outcome = subtitleFileToLoad(file, media?.getPathForFile);
      if ("refusal" in outcome) {
        setNote(outcome.refusal);
        return;
      }
      embed.command(outcome.command);
      // No `setActiveTrack`: while mpv draws, the selected track is whatever
      // mpv says its `sid` is, and it reports one back for having been given
      // `select`. Remembering the label is still ours — it is what
      // `subtitleToRestore` will ask for on the next file.
      setPreferredSubtitle(outcome.label);
      setNote(`Subtitles added from ${file.name}.`);
      return;
    }
    try {
      const text = await file.text();
      const url = URL.createObjectURL(new Blob([subtitleToVtt(text, file.name)], { type: "text/vtt" }));
      const label = file.name.replace(/\.[^.]+$/, "");
      setAdded((previous) => {
        // Adding the same file twice replaces it rather than stacking rows.
        const kept = previous.filter((track) => track.label !== label);
        for (const track of previous) if (track.label === label) URL.revokeObjectURL(track.url);
        return [{ label, language: null, url, source: "added" }, ...kept];
      });
      setActiveTrack(label);
      setPreferredSubtitle(label);
      setNote(`Subtitles added from ${file.name}.`);
    } catch {
      setNote(`${file.name} could not be read.`);
    }
  }, [setPreferredSubtitle, embed.embedded, embed.command]);

  /* ── Showing the chosen track ───────────────────────────────────────── */
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    // `textTracks` is the live list; a <track> element's `default` attribute is
    // only read at parse time, so the mode is set here on every change.
    for (let index = 0; index < element.textTracks.length; index += 1) {
      const track = element.textTracks[index];
      track.mode = track.label === activeTrack ? "showing" : "disabled";
    }
  }, [activeTrack, tracks, source]);

  /* ── Resuming, and remembering where we got to ──────────────────────── */
  useEffect(() => {
    const element = elementRef.current;
    if (!element || transcoding) return;
    // In a transcode the stream already starts at the offset; in direct mode
    // the element has the whole file and has to be told where to begin.
    if (startAt > 0 && element.currentTime < 0.5) element.currentTime = startAt;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    if (!duration || duration <= 0) return;
    const timer = setInterval(() => {
      if (!playing) return;
      remember(path, time, duration);
    }, 5000);
    return () => {
      clearInterval(timer);
      if (duration > 0 && time > 0) remember(path, time, duration);
    };
  }, [path, playing, time, duration, remember]);

  /* ── The snapshot the agent reads ───────────────────────────────────── */
  /*
    What this engine cannot do with this file, and why, in the sentence the
    agent is given instead of a command that would move nothing.

    One action list covers this pane and mpv (`electron/mpvProcess.cjs`), and
    they do not reach equally far: four of the actions exist because mpv can
    do them, and a `<video>` element cannot always. The difference is
    published here, per file, and the gateway spends it — see the header of
    `services/playerControl.ts`. Every sentence names the limit rather than
    the engine, because the operator is not owed our architecture.
  */
  const unsupported = useMemo(() => {
    const list: { action: PlayerAction; reason: string }[] = [];
    /*
      Where mpv holds the picture this memo is nearly empty, and that is the
      point of it existing at all. Four of these limits were the `<video>`
      element's, not the file's: mpv steps a real frame without being told the
      frame rate, reads the file's chapters, and chooses an audio or subtitle
      track by its own number. So the list is per *engine* as well as per file,
      and the agent is told what this playback can actually do rather than what
      the pane could do last time it looked.
    */
    if (embed.embedded) {
      // The one thing that stays true: a track can only be chosen out of a
      // list, and if the engine never reported one there is nothing to name.
      if (!engineTracks?.subtitles.length) {
        list.push({
          action: "subtitles",
          reason: "This file has no subtitles the player can turn on — none inside it, and no subtitle file beside it named after it.",
        });
      }
      if (!engineTracks?.audio.length) {
        list.push({
          action: "audio_track",
          reason: "The player could not read this file's audio tracks, so there is no second track to choose.",
        });
      }
      return list;
    }
    const fps = probe?.probe?.video?.fps ?? null;
    const noFrames = kind !== "video"
      ? "This is audio. There are no frames to step through; `seek_by` moves it in seconds."
      : transcoding
        ? "This file is being converted as it plays, so its picture arrives as a stream with no frame index and a step would reload it. `seek_by` moves it in seconds."
        : !fps
          ? "Stepping needs the file's frame rate and nothing could read it, so a step would be a guess. `seek_by` moves it in seconds."
          : null;
    if (noFrames) list.push({ action: "frame_step", reason: noFrames }, { action: "frame_back", reason: noFrames });
    list.push({
      action: "audio_track",
      reason: "This player plays the file's first audio track and has no way to choose another, whatever else the file carries.",
    });
    list.push({
      action: "chapter",
      reason: "This player does not read the file's chapters, so there is no chapter to go to. `seek` to a position in seconds instead.",
    });
    return list;
  }, [kind, transcoding, probe, embed.embedded, engineTracks]);

  const snapshot = useCallback((overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
    view: "player",
    path,
    title,
    kind,
    series: series
      ? { folder: series.folder, title: series.title, index: series.index, count: series.count, episodes: series.episodes }
      : null,
    playing,
    ended,
    time,
    duration,
    volume,
    muted,
    rate,
    subtitles: { available: subtitleLabels, active: activeSubtitle },
    fullscreen,
    unsupported,
    error: failure,
    ...overrides,
  }), [path, title, kind, series, playing, ended, time, duration, volume, muted, rate, subtitleLabels, activeSubtitle, fullscreen, unsupported, failure]);

  // Continuous: position while playing. Throttled by `publishPlayerState`.
  useEffect(() => {
    publishPlayerState(snapshot());
  }, [snapshot]);

  // Discrete: everything an agent might be waiting on goes immediately.
  useEffect(() => {
    publishPlayerState(snapshot(), { immediate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, ended, muted, activeSubtitle, fullscreen, rate, path, failure]);

  useEffect(() => () => publishPlayerState(null), []);

  /*
    The agent's other way of looking at this: `player_frame` takes a picture of
    what is on screen, and this is the pane offering the element to take it
    from. Registered rather than found, because a window holds more than one
    `<video>` — the editor's compositor keeps one per clip — and picking the
    first one in the document would photograph the wrong surface. Audio has no
    picture, so it hands over nothing and the gateway says so.

    While mpv owns the picture there is no element to offer at all — the frame
    is in another process, on a window layered over this document — so the pane
    offers a capture instead and main asks mpv for the frame. Both halves are
    never true at once, which is why `element` goes null the moment the engine
    has it: an element that is mounted but showing nothing would otherwise be
    photographed as a blank rectangle.
    See services/playerFrame.ts.
  */
  // The position travels with the picture and must be the position at the
  // moment the agent asked, so it is read through a ref: the source below is
  // registered once per file, not four times a second.
  const played = useRef({ time, duration });
  played.current = { time, duration };
  useEffect(
    () => registerPlayerFrameSource(() => ({
      element: kind === "video" && !embed.embedded ? (elementRef.current as HTMLVideoElement | null) : null,
      title,
      engine: kind === "video" && embed.embedded
        ? async () => {
          if (!embed.frame) return { error: "This build of the player cannot photograph the engine's picture." };
          const answer = await embed.frame();
          if (!answer.ok || !answer.image) {
            return { error: answer.reason ?? "The player could not take a picture of what it is showing." };
          }
          return { image: answer.image, time: played.current.time, duration: played.current.duration };
        }
        : null,
    })),
    [kind, title, embed],
  );

  /* ── Seeking ────────────────────────────────────────────────────────── */
  const seekTo = useCallback((seconds: number) => {
    const element = elementRef.current;
    const target = Math.max(0, duration ? Math.min(seconds, duration - 0.25) : seconds);
    setEnded(false);
    if (transcoding) {
      // No file, no ranges: a seek is a new stream from `target`. The element
      // reloads, which is why the position is set here rather than read back.
      setOffset(target);
      setTime(target);
      setWaiting(true);
      return;
    }
    if (element) element.currentTime = target;
    setTime(target);
  }, [duration, transcoding]);

  /* ── One implementation of every control ────────────────────────────── */
  const runCommand = useCallback((command: PlayerCommand): void => {
    const element = elementRef.current;
    /*
      Where mpv holds the picture, the engine gets the command and the switch
      below still runs. That is not belt and braces: the switch is also what
      keeps the chrome honest — the volume slider, the rate menu, the pause
      glyph — and with no element to drive, every `element?.` in it is a no-op.
      Position is the one piece of state it does *not* keep, because mpv
      reports that back and its answer wins. The chosen subtitle is the second
      such piece as of B4, for the same reason and by the same rule.

      The context is the engine's own `track-list`, sent back with every
      command that might name a track. `mpvCommand` resolves a label against it
      — exactly and then loosely, the same two steps the switch below does — so
      "english" finds "English (SDH)" whichever engine is playing. It goes on
      every command rather than only the two that read it because a table that
      is handed the same context every time cannot develop a case that quietly
      needs one it was not given.
    */
    if (embed.embedded && ENGINE_ACTIONS.has(command.action)) {
      embed.command(command, { subtitles: engineTracks?.subtitles ?? [], audio: engineTracks?.audio ?? [] });
    }
    switch (command.action) {
      case "play":
        void element?.play();
        break;
      case "pause":
        element?.pause();
        break;
      case "toggle":
        if (element?.paused) void element.play();
        else element?.pause();
        break;
      case "restart":
        seekTo(0);
        void element?.play();
        break;
      case "seek":
        seekTo(Number(command.value) || 0);
        break;
      case "seek_by":
        seekTo(time + (Number(command.value) || 0));
        break;
      /*
        One frame, as near as an element gets to one.

        The step is `1/fps` off the file's own frame rate, and the position it
        starts from is the element's, not `time` — that state is updated four
        times a second, so stepping from it would step from wherever the last
        `timeupdate` left it rather than from the frame on screen. Paused
        first, because a step while playing is invisible.

        Where the frame rate is unknown, the file is transcoding or this is
        audio, the pane says so in `unsupported` above and the gateway refuses
        the command before it ever arrives here. mpv does this properly
        (`frame-step`, one decoded frame); this is the honest approximation
        until it owns playback.
      */
      case "frame_step":
      case "frame_back": {
        const fps = probe?.probe?.video?.fps ?? null;
        if (!element || !fps) break;
        element.pause();
        const at = transcoding ? time : element.currentTime;
        seekTo(at + (command.action === "frame_step" ? 1 : -1) / fps);
        break;
      }
      case "volume": {
        const next = clampVolume(Number(command.value));
        setVolume(next);
        setMuted(next === 0);
        if (element) {
          element.volume = next;
          element.muted = next === 0;
        }
        break;
      }
      case "mute":
        setMuted(true);
        if (element) element.muted = true;
        break;
      case "unmute":
        setMuted(false);
        if (element) element.muted = false;
        break;
      case "rate": {
        const next = clampRate(Number(command.value) || 1);
        setRate(next);
        if (element) element.playbackRate = next;
        break;
      }
      case "subtitles": {
        const wanted = String(command.value ?? "on");
        if (wanted === "off") {
          setActiveTrack(null);
          setPreferredSubtitle(null);
          break;
        }
        /*
          The labels of whichever list is real — the pane's WebVTT tracks, or
          the engine's. While embedded the engine has already been sent the
          command and will report which track it chose, so the only thing kept
          here is the operator's preference: what is on screen is mpv's answer,
          not this one's.

          **Not yet true while embedded:** the preference is remembered but not
          applied to the next episode. On the element path a track is picked
          up as the file's subtitles load; nothing here re-sends it to mpv.
        */
        const names = embed.embedded ? subtitleLabels : tracks.map((track) => track.label);
        const chosen = wanted === "on"
          ? names[0]
          : names.find((label) => label.toLowerCase() === wanted.toLowerCase())
            ?? names.find((label) => label.toLowerCase().includes(wanted.toLowerCase()));
        if (!chosen) break;
        if (!embed.embedded) setActiveTrack(chosen);
        setPreferredSubtitle(chosen);
        break;
      }
      case "fullscreen": {
        const wanted = typeof command.value === "boolean" ? command.value : !fullscreen;
        if (wanted) void surfaceRef.current?.requestFullscreen?.();
        else if (document.fullscreenElement) void document.exitFullscreen();
        break;
      }
      case "next":
        onNext?.();
        break;
      case "previous":
        onPrevious?.();
        break;
      case "episodes":
        onExit?.();
        break;
      default:
        break;
    }
  }, [seekTo, time, tracks, subtitleLabels, engineTracks, fullscreen, onNext, onPrevious, onExit, setPreferredSubtitle, embed, probe, transcoding]);

  /*
    The agent's commands and the buttons run the same function. `episode` is
    the one this pane cannot answer — it is the gallery that owns the list —
    so it is handled a level up, in `GalleryPane`.
  */
  useEffect(() => subscribePlayerCommands((command) => {
    if (command.action === "episode") return;
    runCommand(command);
  }), [runCommand]);

  /* ── The keyboard, which is the same set of commands again ──────────── */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const map: Record<string, () => void> = {
        " ": () => runCommand({ action: "toggle" }),
        k: () => runCommand({ action: "toggle" }),
        arrowright: () => runCommand({ action: "seek_by", value: PLAYER_LIMITS.seekStep }),
        arrowleft: () => runCommand({ action: "seek_by", value: -PLAYER_LIMITS.seekStep }),
        l: () => runCommand({ action: "seek_by", value: PLAYER_LIMITS.seekStep }),
        j: () => runCommand({ action: "seek_by", value: -PLAYER_LIMITS.seekStep }),
        arrowup: () => runCommand({ action: "volume", value: clampVolume(volume + PLAYER_LIMITS.volumeStep) }),
        arrowdown: () => runCommand({ action: "volume", value: clampVolume(volume - PLAYER_LIMITS.volumeStep) }),
        m: () => runCommand({ action: muted ? "unmute" : "mute" }),
        f: () => runCommand({ action: "fullscreen" }),
        c: () => runCommand({ action: "subtitles", value: activeSubtitle ? "off" : "on" }),
      };
      const run = map[key];
      if (!run) return;
      event.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCommand, volume, muted, activeSubtitle]);

  /* ── Chrome that leaves while the film plays ────────────────────────── */
  useEffect(() => {
    if (kind !== "video" || !playing || menu !== "none" || dragging) {
      setIdle(false);
      return;
    }
    const timer = setTimeout(() => setIdle(true), IDLE_MS);
    return () => clearTimeout(timer);
  }, [kind, playing, menu, dragging, time]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // A note is a reply to something the operator just did; it should not outlive the moment.
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(timer);
  }, [note]);

  /* ── The element's own events ───────────────────────────────────────── */
  const onTimeUpdate = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    setTime(offset + event.currentTarget.currentTime);
    const ranges = event.currentTarget.buffered;
    if (ranges.length > 0) setBuffered(offset + ranges.end(ranges.length - 1));
  };

  const onLoadedMetadata = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const element = event.currentTarget;
    setWaiting(false);
    // A transcoded stream reports Infinity; ffprobe already gave the real one.
    if (Number.isFinite(element.duration) && element.duration > 0 && !transcoding) setDuration(element.duration);
    element.volume = volume;
    element.muted = muted;
    element.playbackRate = rate;
  };

  const onEnded = () => {
    setPlaying(false);
    setEnded(true);
    if (duration) remember(path, duration, duration);
    if (autoplayNext && onNext) onNext();
  };

  const onError = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const code = event.currentTarget.error?.code ?? 0;
    // A transcode that fails has already been through ffmpeg, so the codec
    // advice the direct path gives would be wrong — say what actually broke.
    setFailure(transcoding
      ? `ffmpeg was converting this file for playback and the stream stopped. ${probe?.plan.reason ?? ""}`.trim()
      : describeMediaError(code, path));
  };

  /* ── A subtitle file dropped on the picture ─────────────────────────── */
  const onDragOver = (event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    // Ahead of both the window guard and the file pane's own drop target: a
    // file dropped on a playing video means subtitles, not "open this instead".
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const onDrop = (event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void addSubtitleFile(file);
  };

  const position = duration && duration > 0 ? Math.min(1, time / duration) : 0;
  const bufferedFraction = duration && duration > 0 ? Math.min(1, buffered / duration) : 0;
  const VolumeGlyph = volumeGlyph(volume, muted);
  // Never hidden while mpv holds the picture: the bars are what the video is
  // sized around, so fading them would leave a band of black where they were.
  const chromeHidden = idle && kind === "video" && playing && menu === "none" && !episodesOpen && !embed.embedded;

  if (failure) {
    return (
      <EmptyState
        icon={<AlertTriangle size={26} strokeWidth={1.6} />}
        title={probe?.plan.mode === "unplayable" ? "This file cannot be played here" : "Playback stopped"}
        detail={failure}
      />
    );
  }

  // Through `runCommand`, not `seekTo`: it is the one place that knows whether
  // the seek belongs to this element or to mpv.
  const scrub = (ratio: number) => runCommand({ action: "seek", value: ratio * (duration ?? 0) });

  return (
    <div
      ref={surfaceRef}
      className={`player-surface flex-1 min-h-0 relative bg-black overflow-hidden ${chromeHidden ? "cursor-none" : ""}`}
      onMouseMove={() => setIdle(false)}
      onDoubleClick={() => runCommand({ action: "fullscreen" })}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      {/* The picture, and the whole pane is its click target: a click anywhere
          that is not a control plays or pauses, which is what a player does. */}
      <div className="absolute inset-0" onClick={() => runCommand({ action: "toggle" })}>
        {kind === "video" && embed.embedded ? (
          /*
            Nothing. The picture is mpv's window, layered over this rectangle
            from outside the document — there is no element to render and
            nothing may be drawn here, because anything drawn here would be
            underneath it. The bars above and below are the whole of the pane's
            chrome while this is true. See `useMpvView.ts`.
          */
          null
        ) : kind === "video" ? (
          <video
            key={source ?? "none"}
            ref={elementRef as React.RefObject<HTMLVideoElement>}
            src={source ?? undefined}
            autoPlay={offset > 0 || playing}
            className="w-full h-full object-contain outline-none"
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={onLoadedMetadata}
            onPlay={() => { setPlaying(true); setEnded(false); }}
            onPause={() => setPlaying(false)}
            onWaiting={() => setWaiting(true)}
            onPlaying={() => setWaiting(false)}
            onEnded={onEnded}
            onError={onError}
          >
            {tracks.map((track) => (
              <track key={track.url} kind="subtitles" label={track.label} srcLang={track.language ?? undefined} src={track.url} />
            ))}
          </video>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-surface-sunken">
            <p className="text-md text-ink-high px-8 text-center truncate max-w-full">{title}</p>
            <p className="text-2xs text-ink-muted font-mono">{probe?.probe?.audio?.codec ?? "audio"}</p>
            <audio
              key={source ?? "none"}
              ref={elementRef as React.RefObject<HTMLAudioElement>}
              src={source ?? undefined}
              autoPlay={offset > 0 || playing}
              className="sr-only"
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMetadata}
              onPlay={() => { setPlaying(true); setEnded(false); }}
              onPause={() => setPlaying(false)}
              onWaiting={() => setWaiting(true)}
              onPlaying={() => setWaiting(false)}
              onEnded={onEnded}
              onError={onError}
            >
              {tracks.map((track) => (
                <track key={track.url} kind="subtitles" label={track.label} srcLang={track.language ?? undefined} src={track.url} />
              ))}
            </audio>
          </div>
        )}
      </div>

      {/* Top Bar: Title on left, transcode info & Close 'X' button on far right */}
      <div
        ref={topChromeRef}
        className={`absolute top-0 inset-x-0 z-20 flex items-center justify-between gap-4 px-6 pt-4 pb-8 bg-gradient-to-b from-black/85 via-black/40 to-transparent transition-opacity duration-300 ease-out ${
          chromeHidden ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white/95 truncate tracking-tight">{title}</p>
          {series && (
            <p className="text-2xs text-white/60 font-mono mt-0.5">
              {series.title} · Episode {series.index} of {series.count}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {transcoding && (
            <span className="text-3xs font-mono text-white/70 px-2.5 py-0.5 rounded-full border border-white/20 bg-black/40 backdrop-blur-sm">
              {probe?.plan.mode === "remux" ? "rewrapped" : "converted"} live
            </span>
          )}
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              title="Close (esc)"
              className="w-8 h-8 rounded-full flex items-center justify-center text-white/80 hover:text-white hover:bg-white/15 active:scale-95 transition"
            >
              <X size={20} />
            </button>
          )}
        </div>
      </div>

      {/* Side Navigation: Left / Right floating chevrons */}
      {onPrevious && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPrevious();
          }}
          disabled={!onPrevious}
          title="Previous episode"
          aria-label="Previous episode"
          className={`absolute left-5 top-1/2 -translate-y-1/2 z-20 w-11 h-11 rounded-full bg-black/40 hover:bg-black/75 active:scale-90 backdrop-blur-md border border-white/10 flex items-center justify-center text-white/80 hover:text-white transition shadow-xl duration-300 ease-out ${
            chromeHidden ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
        >
          <ChevronLeft size={24} />
        </button>
      )}

      {onNext && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          disabled={!onNext}
          title="Next episode"
          aria-label="Next episode"
          className={`absolute right-5 top-1/2 -translate-y-1/2 z-20 w-11 h-11 rounded-full bg-black/40 hover:bg-black/75 active:scale-90 backdrop-blur-md border border-white/10 flex items-center justify-center text-white/80 hover:text-white transition shadow-xl duration-300 ease-out ${
            chromeHidden ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
        >
          <ChevronRight size={24} />
        </button>
      )}

      {waiting && !failure && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 size={24} className="animate-spin text-white/60" />
        </div>
      )}

      {/* ── The control bar & scrubber ─────────────────────────────────── */}
      <div
        ref={bottomChromeRef}
        className={`absolute bottom-0 inset-x-0 z-20 bg-gradient-to-t from-black/95 via-black/60 to-transparent pt-10 pb-3 px-6 transition-opacity duration-300 ease-out ${
          chromeHidden ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
        onClick={(event) => event.stopPropagation()}
        onMouseLeave={() => setHover(null)}
      >
        {/* Timeline Scrubber Row */}
        <div className="flex items-center gap-3 w-full mb-1">
          <span className="text-xs font-mono tabular-nums text-white/90 font-medium w-16 text-left flex-shrink-0">
            {formatTimestamp(time)}
          </span>

          <div
            className="relative flex-1 h-6 flex items-center cursor-pointer group/scrub"
            onMouseMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setHover(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)));
            }}
          >
            <input
              type="range"
              className="player-range absolute inset-0 w-full h-full z-20 opacity-0 cursor-pointer"
              min={0}
              max={duration && duration > 0 ? duration : 100}
              step={0.1}
              value={time}
              disabled={!duration}
              aria-label="Position"
              aria-valuetext={`${formatTimestamp(time)} of ${formatTimestamp(duration ?? 0)}`}
              onChange={(event) => runCommand({ action: "seek", value: Number(event.target.value) })}
            />
            {/* Background rail */}
            <div className="absolute inset-x-0 h-1 rounded-full bg-white/20 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-white/30 rounded-full"
                style={{ width: `${bufferedFraction * 100}%` }}
              />
              {/* Sky blue progress rail */}
              <div
                className="absolute inset-y-0 left-0 bg-sky-400 rounded-full"
                style={{ width: `${position * 100}%` }}
              />
            </div>
            {/* Scrubber thumb: crisp white vertical rounded pill */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3.5 bg-white rounded-full shadow pointer-events-none -ml-[3px]"
              style={{ left: `${position * 100}%` }}
            />
            {/* Hover timestamp */}
            {hover !== null && duration ? (
              <span
                className="absolute bottom-full mb-2 px-1.5 py-0.5 -translate-x-1/2 rounded bg-black/85 text-white text-3xs font-mono tabular-nums border border-white/10 opacity-0 group-hover/scrub:opacity-100 pointer-events-none"
                style={{ left: `${hover * 100}%` }}
              >
                {formatTimestamp(hover * duration)}
              </span>
            ) : null}
          </div>

          <span className="text-xs font-mono tabular-nums text-white/70 font-medium w-16 text-right flex-shrink-0">
            {duration ? formatTimestamp(duration) : "00:00:00"}
          </span>
        </div>

        {/* Controls Row */}
        <div
          className="h-10 flex items-center justify-between"
          style={{ paddingRight: fullscreen ? undefined : VERSION_BADGE_STRIP }}
        >
          {/* Left: Play/Pause, Volume */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => runCommand({ action: "toggle" })}
              title={playing ? "Pause (space)" : "Play (space)"}
              className="text-white/90 hover:text-white transition active:scale-95 flex items-center justify-center w-8 h-8 rounded-full hover:bg-white/10"
            >
              {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
            </button>

            {/* Volume */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => runCommand({ action: muted ? "unmute" : "mute" })}
                title={muted ? "Unmute (m)" : "Mute (m)"}
                className="text-white/80 hover:text-white transition w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10"
              >
                <VolumeGlyph size={18} />
              </button>
              <div className="relative w-20 h-5 flex items-center">
                <input
                  type="range"
                  className="player-range absolute inset-0 w-full h-full opacity-0 z-10 cursor-pointer"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  aria-label="Volume"
                  onChange={(event) => runCommand({ action: "volume", value: Number(event.target.value) })}
                />
                <div className="w-full h-1 rounded-full bg-white/25 overflow-hidden">
                  <div
                    className="h-full bg-white rounded-full"
                    style={{ width: `${(muted ? 0 : volume) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Right: Subtitle Track, Playback Speed, Fullscreen */}
          <div className="flex items-center gap-2">
            {/* Subtitles: "Original" pill */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenu(menu === "subtitles" ? "none" : "subtitles")}
                className={`text-xs px-2.5 py-1 rounded transition hover:bg-white/10 flex items-center gap-1 ${
                  activeSubtitle ? "text-sky-400 font-medium bg-white/10" : "text-white/70"
                }`}
                title="Subtitles (c)"
              >
                <span>{activeSubtitle ?? "Original"}</span>
              </button>
              {menu === "subtitles" && (
                <div className="absolute bottom-10 right-0 z-30 min-w-52 py-1 rounded-xl bg-black/90 backdrop-blur-2xl border border-white/15 shadow-2xl text-white">
                  <p className="px-3 py-1 text-3xs text-white/50 uppercase tracking-wider">Subtitles</p>
                  <button
                    type="button"
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/10 transition ${activeSubtitle === null ? "text-sky-400 font-medium" : "text-white/90"}`}
                    onClick={() => { runCommand({ action: "subtitles", value: "off" }); setMenu("none"); }}
                  >
                    Original (Off)
                  </button>
                  {subtitleRows.map((row) => (
                    <button
                      key={row.key}
                      type="button"
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/10 transition flex items-center gap-2 ${activeSubtitle === row.label ? "text-sky-400 font-medium" : "text-white/90"}`}
                      onClick={() => { runCommand({ action: "subtitles", value: row.label }); setMenu("none"); }}
                    >
                      <span className="flex-1 truncate">{row.label}</span>
                      <span className="text-3xs text-white/40">{row.source}</span>
                    </button>
                  ))}
                  <div className="h-px bg-white/10 my-1" />
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-xs text-white/90 hover:bg-white/10 flex items-center gap-2"
                    onClick={() => { pickerRef.current?.click(); setMenu("none"); }}
                  >
                    <FilePlus2 size={13} className="flex-shrink-0" />
                    Add subtitle file…
                  </button>
                </div>
              )}
            </div>

            {/* Speed: "1.0X" pill */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenu(menu === "rate" ? "none" : "rate")}
                className="text-xs font-semibold text-white/80 hover:text-white px-2.5 py-1 rounded hover:bg-white/10 transition tabular-nums"
                title="Playback speed"
              >
                {rate === 1 ? "1.0X" : `${rate.toFixed(1)}X`}
              </button>
              {menu === "rate" && (
                <div className="absolute bottom-10 right-0 z-30 min-w-24 py-1 rounded-xl bg-black/90 backdrop-blur-2xl border border-white/15 shadow-2xl text-white">
                  {RATES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/10 transition ${rate === value ? "text-sky-400 font-semibold" : "text-white/85"}`}
                      onClick={() => { runCommand({ action: "rate", value }); setMenu("none"); }}
                    >
                      {value.toFixed(1)}X
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Fullscreen */}
            <button
              type="button"
              onClick={() => runCommand({ action: "fullscreen" })}
              title="Fullscreen (f)"
              className="text-white/80 hover:text-white transition w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10"
            >
              {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            </button>
          </div>
        </div>
      </div>

      {/* ── Bottom Center Episode Pill Drawer Affordance ─────────────────────── */}
      <div
        className={`absolute bottom-1.5 left-1/2 -translate-x-1/2 z-30 transition-opacity duration-300 ease-out ${
          chromeHidden ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
      >
        <button
          type="button"
          onClick={() => setEpisodesOpen((prev) => !prev)}
          className="flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-black/60 hover:bg-black/85 active:scale-95 backdrop-blur-md border border-white/15 text-xs font-mono text-white/90 hover:text-white transition shadow-xl"
          title="Toggle episodes"
        >
          <span>{series ? `${series.index} / ${series.count}` : "1 / 1"}</span>
          <ChevronUp size={13} className={`transition-transform duration-200 ${episodesOpen ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Episode Drawer Modal */}
      {episodesOpen && series && (
        <div
          className="absolute bottom-12 inset-x-4 max-w-2xl mx-auto z-40 rounded-2xl bg-black/90 backdrop-blur-2xl border border-white/15 p-4 shadow-2xl transition-all"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-medium text-white/90 tracking-wide uppercase">
              {series.title} · Episodes ({series.count})
            </h4>
            <button
              type="button"
              onClick={() => setEpisodesOpen(false)}
              className="text-white/60 hover:text-white text-xs p-1 rounded hover:bg-white/10 transition"
            >
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-56 overflow-y-auto pr-1">
            {series.episodes.map((ep) => {
              const isCurrent = ep.index === series.index;
              return (
                <button
                  key={ep.path}
                  type="button"
                  onClick={() => {
                    dispatchPlayerCommand({ action: "episode", value: ep.index });
                    setEpisodesOpen(false);
                  }}
                  className={`text-left p-2.5 rounded-xl border transition flex flex-col justify-between gap-1.5 ${
                    isCurrent
                      ? "bg-sky-500/20 border-sky-400/80 text-white shadow-[0_0_12px_rgba(56,189,248,0.25)]"
                      : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10 hover:border-white/25 hover:text-white"
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className={`text-2xs font-mono font-semibold px-1.5 py-0.5 rounded ${isCurrent ? "bg-sky-400/20 text-sky-300" : "bg-white/10"}`}>
                      Ep {ep.index}
                    </span>
                    {ep.duration && (
                      <span className="text-3xs font-mono text-white/50">
                        {formatDuration(ep.duration)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-medium truncate w-full" title={ep.title}>
                    {ep.title}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* The picker the menu row opens. Either engine takes a file from
          anywhere on the disk, and neither needs an argument about the
          workspace boundary: the element reads the `File`'s bytes, and mpv is
          given the path the same gesture produced. */}
      <input
        ref={pickerRef}
        type="file"
        accept=".srt,.vtt,text/vtt"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void addSubtitleFile(file);
          event.target.value = "";
        }}
      />

      {dragging && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[var(--player-veil)] pointer-events-none">
          <p className="px-3 py-1.5 rounded-lg bg-surface-raised border border-edge-chrome text-xs text-ink-high">
            Drop a subtitle file to add it
          </p>
        </div>
      )}

      {note && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-20 z-30 px-3 py-1.5 rounded-lg bg-surface-raised border border-edge-chrome text-2xs text-ink-body max-w-[80%] text-center">
          {note}
        </div>
      )}
    </div>
  );
};
