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
  const chromeHidden = idle && kind === "video" && playing && menu === "none" && !episodesOpen;

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

      {/* Top Bar: Title on left, transcode info & Close 'X' button on far right */}
      <div
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
              onChange={(event) => seekTo(Number(event.target.value))}
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
                  activeTrack ? "text-sky-400 font-medium bg-white/10" : "text-white/70"
                }`}
                title="Subtitles (c)"
              >
                <span>{activeTrack ?? "Original"}</span>
              </button>
              {menu === "subtitles" && (
                <div className="absolute bottom-10 right-0 z-30 min-w-52 py-1 rounded-xl bg-black/90 backdrop-blur-2xl border border-white/15 shadow-2xl text-white">
                  <p className="px-3 py-1 text-3xs text-white/50 uppercase tracking-wider">Subtitles</p>
                  <button
                    type="button"
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/10 transition ${activeTrack === null ? "text-sky-400 font-medium" : "text-white/90"}`}
                    onClick={() => { runCommand({ action: "subtitles", value: "off" }); setMenu("none"); }}
                  >
                    Original (Off)
                  </button>
                  {tracks.map((track) => (
                    <button
                      key={track.url}
                      type="button"
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/10 transition flex items-center gap-2 ${activeTrack === track.label ? "text-sky-400 font-medium" : "text-white/90"}`}
                      onClick={() => { runCommand({ action: "subtitles", value: track.label }); setMenu("none"); }}
                    >
                      <span className="flex-1 truncate">{track.label}</span>
                      <span className="text-3xs text-white/40">
                        {track.source === "sidecar" ? "file" : track.source === "embedded" ? "embedded" : "added"}
                      </span>
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
