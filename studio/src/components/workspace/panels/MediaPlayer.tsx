import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ChevronLeft, FilePlus2, Gauge, Loader2, Maximize, Minimize, Pause, Play,
  PictureInPicture2, RotateCcw, RotateCw, SkipBack, SkipForward, Subtitles, Volume1, Volume2, VolumeX,
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
  clampRate, clampVolume, PLAYER_LIMITS, publishPlayerState, subscribePlayerCommands,
  type PlayerCommand, type PlayerEpisodeSummary, type PlayerSnapshot,
} from "../../../services/playerControl";
import { usePlayerStore } from "../../../store/playerStore";

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
  const [menu, setMenu] = useState<"none" | "subtitles" | "rate">("none");
  const [idle, setIdle] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Where the pointer is on the scrubber, 0–1, for the time bubble. */
  const [hover, setHover] = useState<number | null>(null);

  const remember = usePlayerStore((state) => state.remember);
  const preferredSubtitle = usePlayerStore((state) => state.subtitle);
  const setPreferredSubtitle = usePlayerStore((state) => state.setSubtitle);
  const autoplayNext = usePlayerStore((state) => state.autoplayNext);

  const bridge = useMemo(() => workspaceMediaBridge(), []);
  const transcoding = probe?.plan.mode === "remux" || probe?.plan.mode === "transcode";
  const tracks = useMemo(() => [...added, ...found], [added, found]);

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
  }, [path, probe]);

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
   */
  const addSubtitleFile = useCallback(async (file: File) => {
    setNote(null);
    if (!isSubtitleFileName(file.name)) {
      setNote(subtitleFileRefusal(file.name));
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
  }, [setPreferredSubtitle]);

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
    subtitles: { available: tracks.map((track) => track.label), active: activeTrack },
    fullscreen,
    error: failure,
    ...overrides,
  }), [path, title, kind, series, playing, ended, time, duration, volume, muted, rate, tracks, activeTrack, fullscreen, failure]);

  // Continuous: position while playing. Throttled by `publishPlayerState`.
  useEffect(() => {
    publishPlayerState(snapshot());
  }, [snapshot]);

  // Discrete: everything an agent might be waiting on goes immediately.
  useEffect(() => {
    publishPlayerState(snapshot(), { immediate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, ended, muted, activeTrack, fullscreen, rate, path, failure]);

  useEffect(() => () => publishPlayerState(null), []);

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
        const chosen = wanted === "on"
          ? tracks[0]
          : tracks.find((track) => track.label.toLowerCase() === wanted.toLowerCase())
            ?? tracks.find((track) => track.label.toLowerCase().includes(wanted.toLowerCase()));
        if (!chosen) break;
        setActiveTrack(chosen.label);
        setPreferredSubtitle(chosen.label);
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
  }, [seekTo, time, tracks, fullscreen, onNext, onPrevious, onExit, setPreferredSubtitle]);

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
        c: () => runCommand({ action: "subtitles", value: activeTrack ? "off" : "on" }),
      };
      const run = map[key];
      if (!run) return;
      event.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCommand, volume, muted, activeTrack]);

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
  const chromeHidden = idle && kind === "video" && playing;

  if (failure) {
    return (
      <EmptyState
        icon={<AlertTriangle size={26} strokeWidth={1.6} />}
        title={probe?.plan.mode === "unplayable" ? "This file cannot be played here" : "Playback stopped"}
        detail={failure}
      />
    );
  }

  const scrub = (ratio: number) => seekTo(ratio * (duration ?? 0));

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
        {kind === "video" ? (
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

      {/* What is playing, at the top, with the way back. Fades with the rest. */}
      <div
        className={`absolute top-0 inset-x-0 flex items-center gap-2 px-3 py-2.5 bg-[var(--player-scrim)] transition-opacity duration-ds ease-ds ${
          chromeHidden ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
      >
        {onExit && (
          <PlayerButton onClick={onExit} title="All episodes">
            <ChevronLeft size={17} />
          </PlayerButton>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs text-[var(--player-ink)] truncate">{title}</p>
          {series && (
            <p className="text-2xs text-[var(--player-ink-dim)] font-mono mt-0.5">
              {series.title} · episode {series.index} of {series.count}
            </p>
          )}
        </div>
        {transcoding && (
          <span className="text-3xs font-mono text-[var(--player-ink-dim)] px-2 py-1 rounded-full border border-[var(--player-edge)] flex-shrink-0">
            {probe?.plan.mode === "remux" ? "rewrapped" : "converted"} live
          </span>
        )}
      </div>

      {/* The one big affordance: paused film, one button. Nothing while it plays. */}
      {kind === "video" && !playing && !waiting && (
        <button
          type="button"
          onClick={() => runCommand({ action: "play" })}
          aria-label="Play"
          className="absolute inset-0 flex items-center justify-center bg-[var(--player-veil)] transition-opacity duration-ds ease-ds"
        >
          <span className="w-16 h-16 rounded-full bg-accent flex items-center justify-center">
            <Play size={26} className="text-accent-ink ml-1" fill="currentColor" />
          </span>
        </button>
      )}

      {waiting && !failure && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 size={24} className="animate-spin text-[var(--player-ink-dim)]" />
        </div>
      )}

      {/* ── The control bar ─────────────────────────────────────────────── */}
      <div
        className={`absolute bottom-0 inset-x-0 bg-[var(--player-scrim)] transition-opacity duration-ds ease-ds ${
          chromeHidden ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
        onClick={(event) => event.stopPropagation()}
        onMouseLeave={() => setHover(null)}
      >
        {/* The timeline. A real range input, kept transparent over the track
            drawn beneath it: the keyboard and the screen reader get a slider,
            the eye gets a bar this design owns. */}
        <div
          className="relative h-4 mx-3 group/scrub"
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setHover(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)));
          }}
        >
          <input
            type="range"
            className="player-range absolute inset-0 w-full h-full z-10"
            min={0}
            max={duration && duration > 0 ? duration : 100}
            step={0.1}
            value={time}
            disabled={!duration}
            aria-label="Position"
            aria-valuetext={`${formatDuration(time)} of ${formatDuration(duration ?? 0)}`}
            onChange={(event) => seekTo(Number(event.target.value))}
          />
          <div className="player-focus absolute inset-x-0 top-1/2 -translate-y-1/2 h-[3px] group-hover/scrub:h-[5px] rounded-full bg-[var(--player-track)] transition-[height] duration-ds ease-ds overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-[var(--player-buffered)]" style={{ width: `${bufferedFraction * 100}%` }} />
            <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${position * 100}%` }} />
          </div>
          <div
            className="absolute top-1/2 w-3 h-3 -mt-1.5 -ml-1.5 rounded-full bg-accent opacity-0 group-hover/scrub:opacity-100 transition-opacity duration-ds ease-ds pointer-events-none"
            style={{ left: `${position * 100}%` }}
          />
          {/* Where the pointer would land, in minutes and seconds. */}
          {hover !== null && duration ? (
            <span
              className="absolute bottom-full mb-1 px-1.5 py-0.5 -translate-x-1/2 rounded bg-[var(--player-cue)] text-[var(--player-ink)] text-3xs font-mono tabular-nums opacity-0 group-hover/scrub:opacity-100 pointer-events-none"
              style={{ left: `${hover * 100}%` }}
            >
              {formatDuration(hover * duration)}
            </span>
          ) : null}
        </div>

        <div
          className="h-12 flex items-center gap-0.5 pl-2 pr-3"
          // See VERSION_BADGE_STRIP: shared chrome owns the window's
          // bottom-right corner, and a fullscreen element has none over it.
          style={{ paddingRight: fullscreen ? undefined : VERSION_BADGE_STRIP }}
        >
          {series && (
            <PlayerButton onClick={() => onPrevious?.()} disabled={!onPrevious} title="Previous episode">
              <SkipBack size={15} fill="currentColor" />
            </PlayerButton>
          )}
          <PlayerButton onClick={() => runCommand({ action: "toggle" })} title={playing ? "Pause (space)" : "Play (space)"} large>
            {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
          </PlayerButton>
          {series && (
            <PlayerButton onClick={() => onNext?.()} disabled={!onNext} title="Next episode">
              <SkipForward size={15} fill="currentColor" />
            </PlayerButton>
          )}
          <PlayerButton onClick={() => runCommand({ action: "seek_by", value: -PLAYER_LIMITS.seekStep })} title="Back 10 seconds (←)">
            <RotateCcw size={15} />
          </PlayerButton>
          <PlayerButton onClick={() => runCommand({ action: "seek_by", value: PLAYER_LIMITS.seekStep })} title="Forward 10 seconds (→)">
            <RotateCw size={15} />
          </PlayerButton>

          {/* Volume opens on hover rather than holding a slider's width all the
              time, which is what leaves room for the picture's own bar. */}
          <div className="flex items-center group/volume">
            <PlayerButton onClick={() => runCommand({ action: muted ? "unmute" : "mute" })} title={muted ? "Unmute (m)" : "Mute (m)"}>
              <VolumeGlyph size={16} />
            </PlayerButton>
            <div className="relative h-8 w-0 group-hover/volume:w-20 focus-within:w-20 transition-[width] duration-ds ease-ds overflow-hidden">
              <input
                type="range"
                className="player-range absolute inset-0 w-full h-full z-10"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Volume"
                onChange={(event) => runCommand({ action: "volume", value: Number(event.target.value) })}
              />
              <div className="player-focus absolute inset-x-1.5 top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-[var(--player-track)] overflow-hidden">
                <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${(muted ? 0 : volume) * 100}%` }} />
              </div>
            </div>
          </div>

          <span className="ml-2 text-2xs font-mono tabular-nums text-[var(--player-ink)] flex-shrink-0">
            {formatDuration(time)}
            <span className="text-[var(--player-ink-dim)]"> / {duration ? formatDuration(duration) : "—"}</span>
          </span>

          <div className="flex-1" />

          {/* Subtitles. The menu is the whole reason the native controls are
              gone: these come from sidecar files, from streams ffmpeg wrote
              out, and from a file the operator hands us — and Chromium's own
              menu lists none of the three. */}
          <div className="relative">
            <PlayerButton
              onClick={() => setMenu(menu === "subtitles" ? "none" : "subtitles")}
              active={Boolean(activeTrack)}
              title="Subtitles (c)"
            >
              <Subtitles size={16} />
            </PlayerButton>
            {menu === "subtitles" && (
              <div className="absolute bottom-10 right-0 z-20 min-w-52 py-1 rounded-lg bg-surface-popover border border-edge-popover shadow-popover">
                <p className="px-3 py-1 text-3xs text-ink-disabled uppercase tracking-wide">Subtitles</p>
                <button
                  type="button"
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-hover ${activeTrack === null ? "text-accent" : "text-ink-body"}`}
                  onClick={() => { runCommand({ action: "subtitles", value: "off" }); setMenu("none"); }}
                >
                  Off
                </button>
                {tracks.map((track) => (
                  <button
                    key={track.url}
                    type="button"
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-hover flex items-center gap-2 ${activeTrack === track.label ? "text-accent" : "text-ink-body"}`}
                    onClick={() => { runCommand({ action: "subtitles", value: track.label }); setMenu("none"); }}
                  >
                    <span className="flex-1 truncate">{track.label}</span>
                    <span className="text-3xs text-ink-disabled">
                      {track.source === "sidecar" ? "file" : track.source === "embedded" ? "embedded" : "added"}
                    </span>
                  </button>
                ))}
                <div className="h-px bg-edge my-1" />
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-xs text-ink-body hover:bg-surface-hover flex items-center gap-2"
                  onClick={() => { pickerRef.current?.click(); setMenu("none"); }}
                >
                  <FilePlus2 size={12} className="flex-shrink-0" />
                  Add subtitle file…
                </button>
                <p className="px-3 pt-1 pb-1.5 text-3xs text-ink-disabled leading-snug">
                  Or drop an .srt or .vtt onto the picture.
                </p>
              </div>
            )}
          </div>

          <div className="relative">
            <PlayerButton onClick={() => setMenu(menu === "rate" ? "none" : "rate")} active={rate !== 1} title="Speed">
              {rate === 1 ? <Gauge size={16} /> : <span className="text-2xs font-mono tabular-nums">{rate}×</span>}
            </PlayerButton>
            {menu === "rate" && (
              <div className="absolute bottom-10 right-0 z-20 min-w-24 py-1 rounded-lg bg-surface-popover border border-edge-popover shadow-popover">
                {RATES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-hover ${rate === value ? "text-accent" : "text-ink-body"}`}
                    onClick={() => { runCommand({ action: "rate", value }); setMenu("none"); }}
                  >
                    {value}×
                  </button>
                ))}
              </div>
            )}
          </div>

          {kind === "video" && (
            <PlayerButton
              onClick={() => void (elementRef.current as HTMLVideoElement | null)?.requestPictureInPicture?.()}
              title="Picture in picture"
            >
              <PictureInPicture2 size={16} />
            </PlayerButton>
          )}
          <PlayerButton onClick={() => runCommand({ action: "fullscreen" })} title="Fullscreen (f)">
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </PlayerButton>
        </div>
      </div>

      {/* The picker the menu row opens. Reading the File directly is what keeps
          a subtitle from anywhere on the disk working without a path, an IPC
          bridge, or an argument about the workspace boundary. */}
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
