import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, FileQuestion, FileSpreadsheet, FileText, FolderOpen, Music, Play } from "lucide-react";
import { EmptyState } from "../../ui";
import type { PanelTab } from "../../../store/panelStore";
import { usePanelStore } from "../../../store/panelStore";
import { useStudioStore } from "../../../store/studioStore";
import { usePlayerStore } from "../../../store/playerStore";
import { formatBytes } from "../../../services/guardianService";
import { WorkspaceService } from "../../../services/workspaceService";
import { FileIcon } from "../../sidebar/FileTree";
import {
  describeGallery, findTreeNode, galleryOf, isOpenable, resumePoint, watchedFraction,
  THUMBNAIL_MAX_BYTES, WATCHED_RATIO,
  type Gallery, type GalleryEntry,
} from "../../../services/workspaceGallery";
import {
  formatDuration, workspaceMediaBridge, workspaceMediaUrl, NEEDS_DESKTOP_APP,
} from "../../../services/workspaceMedia";
import { publishPlayerState, subscribePlayerCommands, type PlayerEpisodeSummary } from "../../../services/playerControl";
import { MediaPlayer } from "./MediaPlayer";

/**
 * A folder, as a gallery.
 *
 * *"implement the gallery view not just for videos but for all files — this
 * will make it uniform since we use the same file pane for all of them."*
 *
 * One panel, one gesture: click a folder anywhere and see what is in it. The
 * cards differ by what the thing is — a video shows a frame of itself, an
 * image shows itself, everything else shows the same glyph the file tree gives
 * it, so the two surfaces never disagree about what a `.tsx` looks like — and
 * a click opens the thing: a folder navigates this panel, a video plays in it,
 * anything else goes to the File panel, which is the surface that renders a
 * file. A card with no viewer behind it says so rather than pretending, which
 * is the one rule this grid shares with every other surface in the app.
 *
 * **A folder of videos is additionally a series.** Two or more videos put a
 * header on the gallery — the title, what is in it, and one button that
 * resumes where the operator left off — and number the video cards as
 * episodes. That is a layer, not a second panel: the same grid, the same
 * cards, with a progress bar under the started ones and a tick on the
 * finished. `services/workspaceGallery.ts` owns both rules and is pure, so
 * the gallery is a function of the tree the sidebar already drew and cannot
 * disagree with it.
 *
 * **One panel that navigates, not one per folder.** Panel identity for this
 * kind is the kind alone (`store/panelStore.ts`), so clicking through six
 * folders leaves one tab rather than six. `trail` is the way back up.
 */

/** How many cards load their preview immediately; the rest wait for the viewport. */
const EAGER_PREVIEWS = 12;
/** Where in a video the poster frame is taken from — far enough in to miss a black first frame. */
const POSTER_AT = 8;

/** The glyph a card falls back to, matched to what the kind can do. */
const KIND_GLYPH: Record<string, React.ElementType> = {
  audio: Music,
  pdf: FileText,
  sheet: FileSpreadsheet,
  other: FileQuestion,
};

const EntryCard: React.FC<{
  entry: GalleryEntry;
  eager: boolean;
  watched: number;
  highlighted: boolean;
  onOpen: () => void;
  onDuration?: (seconds: number) => void;
}> = ({ entry, eager, watched, highlighted, onOpen, onDuration }) => {
  const bridge = useMemo(() => workspaceMediaBridge(), []);
  const cardRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(eager);
  const [thumbnail, setThumbnail] = useState<string | null>(null);

  useEffect(() => {
    if (visible || !cardRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((candidate) => candidate.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [visible]);

  /*
    An image thumbnail is the file's own bytes through the same reader every
    other picture in this app uses, fetched only once the card is on screen and
    only under the cap — a gallery of forty photographs should not read forty
    files before it can draw. Past the cap the card keeps its glyph, which is
    what it would have shown anyway.
  */
  useEffect(() => {
    if (!visible || entry.kind !== "image" || (entry.size ?? 0) > THUMBNAIL_MAX_BYTES) return;
    let url: string | null = null;
    let alive = true;
    WorkspaceService.readFile(entry.path)
      .then((file) => {
        if (!alive || file.encoding !== "base64") return;
        const binary = atob(file.content);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
        setThumbnail(url);
      })
      .catch(() => {
        /* A picture that will not read is one card without a thumbnail, not a failed folder. */
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [visible, entry.kind, entry.path, entry.size]);

  const videoUrl = visible && entry.kind === "video" ? workspaceMediaUrl(bridge, entry.path) : null;
  const finished = watched >= WATCHED_RATIO;
  const Glyph = KIND_GLYPH[entry.kind];

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={onOpen}
      className={`episode-card group text-left rounded-lg overflow-hidden border transition-colors duration-ds ease-ds ${
        highlighted ? "border-accent-line bg-surface-active" : "border-edge-chrome bg-surface-sunken hover:bg-surface-hover"
      }`}
      title={entry.name}
    >
      <div className="relative aspect-video bg-surface-skeleton overflow-hidden flex items-center justify-center">
        {videoUrl && (
          <video
            src={`${videoUrl}#t=${POSTER_AT}`}
            preload="metadata"
            muted
            playsInline
            tabIndex={-1}
            aria-hidden
            className="w-full h-full object-cover"
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              if (Number.isFinite(element.duration) && element.duration > 0) onDuration?.(element.duration);
              // A container Chromium cannot demux paints nothing, and the card
              // falls back to its number — the honest empty state.
              if (element.currentTime === 0) element.currentTime = Math.min(POSTER_AT, element.duration / 4);
            }}
          />
        )}

        {thumbnail && <img src={thumbnail} alt="" aria-hidden className="w-full h-full object-cover" />}

        {/* The fallback face of a card: the tree's own icon for a file, a folder
            glyph for a folder, and a kind glyph for the few the tree draws
            generically. One vocabulary across both surfaces. */}
        {!videoUrl && !thumbnail && (
          entry.kind === "folder"
            ? <FolderOpen size={26} strokeWidth={1.4} className="text-ink-disabled" />
            : Glyph
              ? <Glyph size={24} strokeWidth={1.4} className="text-ink-disabled" />
              : <div className="scale-[1.7]"><FileIcon name={entry.name} /></div>
        )}

        {entry.episode !== null && (
          <span className="absolute top-1.5 left-2 text-2xs font-mono text-ink-high [text-shadow:0_1px_2px_rgb(0_0_0/0.7)]">
            {entry.code ?? String(entry.episode).padStart(2, "0")}
          </span>
        )}

        {finished && (
          <span className="absolute top-1.5 right-2 w-4 h-4 rounded-full bg-accent flex items-center justify-center" title="Watched">
            <Check size={10} className="text-accent-ink" strokeWidth={3} />
          </span>
        )}

        {/* Only what plays here gets a play button. A card that opens a file
            elsewhere would be lying about where the click goes. */}
        {entry.kind === "video" && (
          <span className="episode-play absolute inset-0 flex items-center justify-center bg-surface/45">
            <span className="w-9 h-9 rounded-full bg-accent flex items-center justify-center">
              <Play size={15} className="text-accent-ink ml-0.5" fill="currentColor" />
            </span>
          </span>
        )}
        {entry.kind === "folder" && (
          <span className="episode-play absolute inset-0 flex items-center justify-center bg-surface/45">
            <span className="w-9 h-9 rounded-full bg-surface-raised border border-edge-strong flex items-center justify-center">
              <ChevronRight size={15} className="text-ink-high" />
            </span>
          </span>
        )}

        {watched > 0 && !finished && (
          <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-edge-strong">
            <span className="block h-full bg-accent" style={{ width: `${watched * 100}%` }} />
          </span>
        )}
      </div>

      <div className="px-2.5 py-2">
        <p className={`text-xs truncate ${isOpenable(entry.kind) ? "text-ink-high" : "text-ink-muted"}`}>{entry.title}</p>
        <p className="text-2xs text-ink-disabled font-mono mt-0.5 truncate">
          {entry.kind === "folder"
            ? entry.children === null ? "Folder" : `${entry.children} ${entry.children === 1 ? "item" : "items"}`
            : entry.size !== null ? formatBytes(entry.size) : ""}
          {entry.subtitles.length > 0 ? ` · ${entry.subtitles.length === 1 ? "subtitles" : `${entry.subtitles.length} subtitle tracks`}` : ""}
        </p>
      </div>
    </button>
  );
};

export const GalleryPane: React.FC<{ panel: PanelTab }> = ({ panel }) => {
  const files = useStudioStore((state) => state.files);
  const workspacePath = useStudioStore((state) => state.workspacePath);
  const showFile = useStudioStore((state) => state.showFile);
  const showFolder = useStudioStore((state) => state.showFolder);
  const update = usePanelStore((state) => state.update);
  const positions = usePlayerStore((state) => state.positions);
  const autoplayNext = usePlayerStore((state) => state.autoplayNext);
  const setAutoplayNext = usePlayerStore((state) => state.setAutoplayNext);

  const folderPath = panel.path ?? "";
  const node = useMemo(() => (folderPath ? findTreeNode(files, folderPath) : null), [files, folderPath]);

  /*
    With no path the panel shows the project root, which the tree holds as a
    bare list rather than as a node. A root gallery is a real answer — it is
    the project — so it is drawn rather than refused.
  */
  const gallery: Gallery | null = useMemo(() => {
    if (node) return galleryOf(node);
    if (folderPath) return null;
    const name = workspacePath.split("/").filter(Boolean).pop() ?? "Workspace";
    return galleryOf({ id: "root", name, path: "", type: "directory", children: files });
  }, [node, folderPath, files, workspacePath]);

  const series = gallery?.series ?? null;

  /** 1-based episode, or null for the grid. */
  const [playing, setPlaying] = useState<number | null>(null);
  const [startAt, setStartAt] = useState(0);
  const [durations, setDurations] = useState<Record<string, number>>({});

  const bridge = useMemo(() => workspaceMediaBridge(), []);

  // The tab wears the folder's name, so a strip of panels says which is which.
  useEffect(() => {
    if (gallery) update(panel.id, { label: gallery.title });
  }, [gallery?.title, panel.id, update]);

  // Navigating to another folder leaves the player behind with it.
  useEffect(() => setPlaying(null), [folderPath]);

  const summaries: PlayerEpisodeSummary[] = useMemo(() => (series?.episodes ?? []).map((episode) => ({
    index: episode.index,
    path: episode.path,
    title: episode.title,
    code: episode.code,
    duration: durations[episode.path] ?? null,
    watched: watchedFraction(positions[episode.path]),
  })), [series, durations, positions]);

  const openEpisode = useCallback((index: number, at?: number) => {
    if (!series) return;
    const episode = series.episodes.find((candidate) => candidate.index === index);
    if (!episode) return;
    const position = positions[episode.path];
    // Resuming an episode all but finished would land on the credits.
    const resume = at ?? (position && position.duration > 0 && position.time / position.duration < WATCHED_RATIO ? position.time : 0);
    setStartAt(resume);
    setPlaying(index);
  }, [series, positions]);

  /** What a card's click does, by what the card is. */
  const openEntry = useCallback((entry: GalleryEntry) => {
    if (entry.kind === "folder") {
      showFolder(entry.path);
      return;
    }
    if (entry.kind === "video" && entry.episode !== null) {
      openEpisode(entry.episode);
      return;
    }
    // Everything else — including a lone video and any audio — is the File
    // panel's, which renders it with the same player and the same viewers a
    // click in the tree would have used. One road, not two.
    void showFile(entry.path);
  }, [showFolder, showFile, openEpisode]);

  /*
    `episode` and `episodes` are the two commands the player cannot answer: it
    holds one file and knows nothing about the list.
  */
  useEffect(() => subscribePlayerCommands((command) => {
    if (command.action === "episode") openEpisode(Number(command.value) || 1);
    else if (command.action === "episodes") setPlaying(null);
  }), [openEpisode]);

  /* The grid publishes too, so an agent asked "what is open?" hears about a folder nobody has started. */
  useEffect(() => {
    if (playing !== null || !gallery) return;
    publishPlayerState({
      view: "episodes",
      path: gallery.folder,
      title: gallery.title,
      kind: series ? "video" : null,
      series: series
        ? { folder: gallery.folder, title: gallery.title, index: null, count: series.episodes.length, episodes: summaries }
        : null,
      playing: false,
      ended: false,
      time: 0,
      duration: null,
      volume: 1,
      muted: false,
      rate: 1,
      subtitles: { available: [], active: null },
      /*
        Nothing is playing on the gallery, so the four actions that reach into
        a file reach into nothing. Said here rather than left to be discovered:
        the grid's own answer is `episode` with a number, and the refusal names
        it. See the header of services/playerControl.ts.
      */
      unsupported: (["frame_step", "frame_back", "chapter", "audio_track"] as const).map((action) => ({
        action,
        reason: "Nothing is playing yet — this is the episode gallery. Start one with `episode` and a number first.",
      })),
      fullscreen: false,
      error: null,
    }, { immediate: true });
  }, [playing, gallery, series, summaries]);

  if (!gallery) {
    return (
      <EmptyState
        icon={<FolderOpen size={26} strokeWidth={1.6} />}
        title="Loading the folder…"
        detail="This gallery is drawn from the file tree, and it appears as soon as the tree does."
      />
    );
  }

  const current = playing !== null && series ? series.episodes.find((episode) => episode.index === playing) ?? null : null;

  if (current) {
    if (!bridge) {
      return <EmptyState icon={<FolderOpen size={26} strokeWidth={1.6} />} title="Playback needs the desktop app" detail={NEEDS_DESKTOP_APP} />;
    }
    return (
      <MediaPlayer
        key={current.path}
        path={current.path}
        kind="video"
        title={current.title}
        sidecars={current.subtitles}
        series={{ folder: gallery.folder, title: gallery.title, index: current.index, count: series!.episodes.length, episodes: summaries }}
        startAt={startAt}
        onNext={current.index < series!.episodes.length ? () => openEpisode(current.index + 1, 0) : undefined}
        onPrevious={current.index > 1 ? () => openEpisode(current.index - 1) : undefined}
        onExit={() => setPlaying(null)}
      />
    );
  }

  const resume = series ? resumePoint(series, positions) : null;
  const trail = gallery.folder ? gallery.folder.split("/") : [];

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface-sunken overflow-auto">
      {/*
        The header is the folder, stated once: where it is, what is in it, and
        — when it is a series — the one action that matters. Flat, no hero
        image: there is no artwork for a folder, and a slab pretending to be
        one is exactly the decoration the design rules refuse.
      */}
      <div className="flex-shrink-0 px-5 pt-4 pb-4 border-b border-edge-chrome bg-surface">
        <nav className="flex items-center gap-1 text-2xs text-ink-muted font-mono mb-1.5 flex-wrap">
          <button type="button" className="hover:text-ink-high transition-colors duration-ds ease-ds" onClick={() => showFolder("")}>
            {workspacePath.split("/").filter(Boolean).pop() ?? "Workspace"}
          </button>
          {trail.map((segment, index) => (
            <React.Fragment key={`${segment}-${index}`}>
              <ChevronRight size={11} className="text-ink-disabled" />
              {index === trail.length - 1 ? (
                <span className="text-ink-high">{segment}</span>
              ) : (
                <button
                  type="button"
                  className="hover:text-ink-high transition-colors duration-ds ease-ds"
                  onClick={() => showFolder(trail.slice(0, index + 1).join("/"))}
                >
                  {segment}
                </button>
              )}
            </React.Fragment>
          ))}
        </nav>

        <p className="text-md text-ink-bright">{gallery.title}</p>
        <p className="text-xs text-ink-muted mt-1">
          {describeGallery(gallery.counts)}
          {series && resume && resume.time > 0 ? ` · you are ${formatDuration(resume.time)} into episode ${resume.index}` : ""}
        </p>

        {series && resume && (
          <div className="flex items-center gap-2 mt-3">
            <button
              type="button"
              onClick={() => openEpisode(resume.index)}
              className="inline-flex items-center gap-2 h-8 px-3.5 rounded-md bg-accent text-accent-ink text-xs hover:bg-accent-hover transition-colors duration-ds ease-ds"
            >
              <Play size={13} fill="currentColor" />
              {resume.time > 0 ? `Resume episode ${resume.index}` : resume.index > 1 ? `Play episode ${resume.index}` : "Play"}
            </button>
            <label className="flex items-center gap-1.5 text-2xs text-ink-muted cursor-pointer select-none ml-1">
              <input
                type="checkbox"
                checked={autoplayNext}
                onChange={(event) => setAutoplayNext(event.target.checked)}
                className="accent-accent"
              />
              Play the next episode automatically
            </label>
          </div>
        )}
      </div>

      {gallery.entries.length === 0 ? (
        <EmptyState icon={<FolderOpen size={26} strokeWidth={1.6} />} title="This folder is empty" detail="Nothing here yet — drop a file into it, or ask in a chat message." />
      ) : (
        <div className="p-4 grid gap-3 grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
          {gallery.entries.map((entry, index) => (
            <EntryCard
              key={entry.path}
              entry={entry}
              eager={index < EAGER_PREVIEWS}
              watched={watchedFraction(positions[entry.path])}
              highlighted={Boolean(series && resume && entry.episode === resume.index)}
              onOpen={() => openEntry(entry)}
              onDuration={(seconds) => setDurations((previous) => (previous[entry.path] === seconds ? previous : { ...previous, [entry.path]: seconds }))}
            />
          ))}
        </div>
      )}
    </div>
  );
};
