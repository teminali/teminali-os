/**
 * A folder, read as a gallery — and a folder of videos, read as a series.
 *
 * Every folder opens the same way, because the operator's gesture is the same
 * one: they clicked a folder and expect to see what is in it. What differs is
 * how a card is drawn and what opening one does, and that is a single
 * classification — `entryKind` — rather than a second panel for pictures and a
 * third for films. A folder that holds two or more videos additionally
 * qualifies as a *series*, which adds the resume header and numbers the
 * episodes; that is a layer on the gallery, not a different thing.
 *
 * Nothing here touches the network or the DOM: the tree the sidebar already
 * holds is the whole input, and every rule the gallery and the player need —
 * what counts as a series, how entries are ordered and named, which sidecar
 * file subtitles a video, how an `.srt` becomes WebVTT — is a pure function so
 * `tests/workspace-gallery.test.mjs` can pin it under node.
 *
 * The one number that has to agree with the gateway is `SERIES_MIN_EPISODES`:
 * `server/workspace.js` uses the same threshold when it tells the agent what
 * kind of folder it just opened, and the test asserts the two are equal —
 * a folder one side calls a series and the other calls a folder is a tool that
 * describes something the operator is not looking at.
 */

import type { FileItem } from "../types";
// The explicit `.ts` is deliberate, and the same reason `changeSet.ts` gives:
// node's test runner resolves an ESM specifier literally, so a `.mjs` test
// importing this file cannot follow an extensionless one. Vite and `tsc`
// (`allowImportingTsExtensions`) both accept it.
import { workspaceMediaOf } from "./workspaceMedia.ts";

/** Fewer videos than this in a folder, and it is a folder, not a series. */
export const SERIES_MIN_EPISODES = 2;

/** Sidecar subtitle formats the player admits. `.ass`/`.ssa` are not VTT-shaped and are not pretended. */
export const SUBTITLE_EXTENSIONS: readonly string[] = [".srt", ".vtt"];

/** Watched this far, and the episode counts as finished. */
export const WATCHED_RATIO = 0.9;

export interface SubtitleTrack {
  /** Workspace-relative path of the sidecar file. */
  path: string;
  /** What the menu calls it: a language name when the file names one, else "Subtitles". */
  label: string;
  /** The BCP-47-ish tag the file carried, or null. */
  language: string | null;
}

export interface Episode {
  /** 1-based, in play order. */
  index: number;
  path: string;
  name: string;
  /** The file name, made readable. */
  title: string;
  /** "S01E02", or "02", when the file name carries one; else null. */
  code: string | null;
  size: number | null;
  modified: string | null;
  subtitles: SubtitleTrack[];
}

export interface Series {
  folder: string;
  title: string;
  episodes: Episode[];
}

/**
 * What a card in the gallery is.
 *
 * Deliberately coarse: the kinds are the *viewers this app has*, not a mime
 * taxonomy. `FilePane` renders text, images, PDFs and spreadsheets and the
 * player renders video and audio, so those are the six that can be opened,
 * and `other` is the honest name for a card whose click will say there is no
 * viewer rather than pretending.
 */
export type EntryKind = "folder" | "video" | "audio" | "image" | "pdf" | "sheet" | "text" | "other";

export interface GalleryEntry {
  kind: EntryKind;
  path: string;
  name: string;
  title: string;
  size: number | null;
  modified: string | null;
  /** For a folder: how many children the tree knows about, or null when it has not been read. */
  children: number | null;
  /** For a video in a series: its 1-based position. Null otherwise. */
  episode: number | null;
  /** For a video: the episode number carried by the file name. */
  code: string | null;
  /** For a video: the sidecar subtitle files sitting beside it. */
  subtitles: SubtitleTrack[];
}

export interface Gallery {
  folder: string;
  title: string;
  entries: GalleryEntry[];
  /** Present when the folder holds `SERIES_MIN_EPISODES` or more videos. */
  series: Series | null;
  counts: Record<EntryKind, number>;
}

/**
 * Images the pane will draw as a thumbnail, and the cap it draws them under.
 *
 * A thumbnail is the file's own bytes through `/api/workspace/file`, which is
 * the reader every other picture in this app comes through — so the cap is
 * about a gallery of forty photographs, not about safety. Past it the card
 * shows its glyph, which is what it would have shown anyway before this pane
 * existed.
 */
export const THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const SHEET_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".json",
  ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".srt", ".toml", ".ts", ".tsx", ".txt",
  ".vtt", ".xml", ".yaml", ".yml",
]);
/** Files whose whole name is their extension — the tree lists these, so the gallery must too. */
const TEXT_NAMES = new Set([
  ".babelrc", ".browserslistrc", ".dockerignore", ".editorconfig", ".eslintrc", ".gitattributes",
  ".gitignore", ".gitmodules", ".npmignore", ".npmrc", ".nvmrc", ".prettierrc", ".tool-versions",
  "changelog", "codeowners", "dockerfile", "gemfile", "licence", "license", "makefile",
  "procfile", "readme", "rakefile",
]);

export interface PlaybackPosition {
  time: number;
  duration: number;
  /** When it was last written, epoch ms. */
  at: number;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function baseOf(name: string): string {
  const extension = extensionOf(name);
  return extension ? name.slice(0, -extension.length) : name;
}

/** Numeric-aware ordering, so "Episode 2" sorts before "Episode 10". */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Depth-first lookup of one path in the tree the sidebar holds. */
export function findTreeNode(files: FileItem[], path: string): FileItem | null {
  for (const item of files) {
    if (item.path === path) return item;
    if (item.children && path.startsWith(`${item.path}/`)) {
      const found = findTreeNode(item.children, path);
      if (found) return found;
    }
  }
  return null;
}

export function isVideoFile(name: string): boolean {
  return workspaceMediaOf(name)?.kind === "video";
}

/**
 * The file name as a title: extension gone, dots and underscores as spaces,
 * runs of whitespace collapsed. Deliberately no cleverness about release tags —
 * "1080p" stays, because guessing which words are noise gets it wrong more
 * often than a slightly long title does.
 */
export function episodeTitle(name: string): string {
  return baseOf(name)
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—]+|[\s\-–—]+$/g, "")
    .trim() || name;
}

/** The episode number the file name carries, normalised, or null. */
export function episodeCode(name: string): string | null {
  const base = baseOf(name);
  const seasonal = base.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i);
  if (seasonal) return `S${seasonal[1].padStart(2, "0")}E${seasonal[2].padStart(2, "0")}`;
  const worded = base.match(/\b(?:episode|ep|part|chapter)\s*[._-]?\s*(\d{1,3})\b/i);
  if (worded) return worded[1].padStart(2, "0");
  const leading = base.match(/^\s*(\d{1,3})\s*[\s._-]/);
  if (leading) return leading[1].padStart(2, "0");
  return null;
}

/**
 * A language tag becomes a name when the runtime knows it ("en" → "English",
 * "pt-BR" → "Brazilian Portuguese"); otherwise the tag itself is the label,
 * which is still better than a menu of three rows that all say "Subtitles".
 */
export function languageLabel(tag: string): string {
  try {
    const names = new Intl.DisplayNames(undefined, { type: "language" });
    const label = names.of(tag);
    if (label && label.toLowerCase() !== tag.toLowerCase()) return label;
  } catch {
    /* An unknown or malformed tag: the tag is the label. */
  }
  return tag;
}

/**
 * The sidecars that subtitle one video: siblings with a subtitle extension
 * whose name is the video's base name, or the base name followed by a dot and
 * a language ("Episode 1.en.srt"). Ordered so an exact match comes first.
 */
export function subtitleTracksFor(video: FileItem, siblings: FileItem[]): SubtitleTrack[] {
  const base = baseOf(video.name).toLowerCase();
  const tracks: SubtitleTrack[] = [];
  for (const sibling of siblings) {
    if (sibling.type !== "file" || !SUBTITLE_EXTENSIONS.includes(extensionOf(sibling.name))) continue;
    const siblingBase = baseOf(sibling.name);
    const lower = siblingBase.toLowerCase();
    if (lower === base) {
      tracks.push({ path: sibling.path, label: "Subtitles", language: null });
    } else if (lower.startsWith(`${base}.`)) {
      const language = siblingBase.slice(base.length + 1);
      if (!language || language.length > 32) continue;
      tracks.push({ path: sibling.path, label: languageLabel(language), language });
    }
  }
  return tracks.sort((a, b) => (a.language === null ? -1 : b.language === null ? 1 : naturalCompare(a.label, b.label)));
}

/**
 * The series a folder holds, or null when it holds fewer than
 * `SERIES_MIN_EPISODES` videos among its *direct* children. Subfolders are
 * not descended: a season folder is its own series, and a project folder with
 * two renders three levels down is not one.
 */
export function seriesOf(folder: FileItem): Series | null {
  if (folder.type !== "directory" || !folder.children) return null;
  const siblings = folder.children;
  const videos = siblings.filter((child) => child.type === "file" && isVideoFile(child.name));
  if (videos.length < SERIES_MIN_EPISODES) return null;
  const episodes = [...videos]
    .sort((a, b) => naturalCompare(a.name, b.name))
    .map((video, position) => ({
      index: position + 1,
      path: video.path,
      name: video.name,
      title: episodeTitle(video.name),
      code: episodeCode(video.name),
      size: typeof video.size === "number" ? video.size : null,
      modified: video.modified ?? null,
      subtitles: subtitleTracksFor(video, siblings),
    }));
  // The folder's own name, unretouched. `episodeTitle` tidies a *file* name
  // into a caption; a folder is a thing on disk the operator named and can
  // see in the tree, and calling it something else in the header would be a
  // small lie between two surfaces showing the same folder.
  return { folder: folder.path, title: folder.name, episodes };
}

/** True when the folder additionally qualifies for the series header. */
export function isSeriesFolder(item: FileItem): boolean {
  return seriesOf(item) !== null;
}

/** What kind of card one tree node gets. `.svg` is text here, as it is in the tree: markup an operator edits. */
export function entryKind(item: FileItem): EntryKind {
  if (item.type === "directory") return "folder";
  const media = workspaceMediaOf(item.name);
  if (media) return media.kind;
  const extension = extensionOf(item.name);
  if (extension === ".svg") return "text";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if (SHEET_EXTENSIONS.has(extension)) return "sheet";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (TEXT_NAMES.has(item.name.toLowerCase())) return "text";
  return "other";
}

/** True when a click on this card has somewhere to go. `other` is the card that says so instead. */
export function isOpenable(kind: EntryKind): boolean {
  return kind !== "other";
}

const EMPTY_COUNTS: Record<EntryKind, number> = {
  folder: 0, video: 0, audio: 0, image: 0, pdf: 0, sheet: 0, text: 0, other: 0,
};

/**
 * One folder, as cards.
 *
 * Folders lead, then files, each group ordered the way the tree orders them —
 * numerically aware, so `10` follows `2`. A video that belongs to the series
 * carries its episode number, so the card and the player agree about which
 * one is third.
 */
export function galleryOf(folder: FileItem): Gallery | null {
  if (folder.type !== "directory") return null;
  const children = folder.children ?? [];
  const series = seriesOf(folder);
  const episodeOf = new Map((series?.episodes ?? []).map((episode) => [episode.path, episode]));
  const counts = { ...EMPTY_COUNTS };

  const entries = [...children]
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return naturalCompare(a.name, b.name);
    })
    .map((child) => {
      const kind = entryKind(child);
      counts[kind] += 1;
      const episode = episodeOf.get(child.path);
      return {
        kind,
        path: child.path,
        name: child.name,
        title: kind === "folder" ? child.name : episodeTitle(child.name),
        size: typeof child.size === "number" ? child.size : null,
        modified: child.modified ?? null,
        children: child.type === "directory" ? child.children?.length ?? null : null,
        episode: episode?.index ?? null,
        code: kind === "video" ? episodeCode(child.name) : null,
        subtitles: kind === "video" ? (episode?.subtitles ?? subtitleTracksFor(child, children)) : [],
      };
    });

  return { folder: folder.path, title: folder.name, entries, series, counts };
}

const PLURALS: Record<EntryKind, [string, string]> = {
  folder: ["folder", "folders"],
  video: ["video", "videos"],
  audio: ["audio file", "audio files"],
  image: ["image", "images"],
  pdf: ["PDF", "PDFs"],
  sheet: ["spreadsheet", "spreadsheets"],
  text: ["document", "documents"],
  other: ["other file", "other files"],
};

/**
 * The header's one line: what is actually in this folder, biggest group first.
 * Three groups at most and then a remainder, because a header that lists eight
 * kinds is a header nobody reads.
 */
export function describeGallery(counts: Record<EntryKind, number>): string {
  const groups = (Object.entries(counts) as [EntryKind, number][])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (groups.length === 0) return "Empty";
  const named = groups.slice(0, 3).map(([kind, count]) => `${count} ${PLURALS[kind][count === 1 ? 0 : 1]}`);
  const rest = groups.slice(3).reduce((total, [, count]) => total + count, 0);
  if (rest > 0) named.push(`${rest} more`);
  return named.join(" · ");
}

export function describeEpisodeCount(count: number): string {
  return count === 1 ? "1 episode" : `${count} episodes`;
}

/**
 * Where to start when the operator presses Play on the series: the episode
 * they were last in the middle of; failing that, the one after the last they
 * finished; failing that, the first. `positions` is keyed by episode path.
 */
export function resumePoint(series: Series, positions: Record<string, PlaybackPosition>): { index: number; time: number } {
  let latest: { index: number; time: number; at: number } | null = null;
  let lastFinished = 0;
  for (const episode of series.episodes) {
    const position = positions[episode.path];
    if (!position || !(position.duration > 0)) continue;
    const finished = position.time / position.duration >= WATCHED_RATIO;
    if (finished) {
      lastFinished = Math.max(lastFinished, episode.index);
      continue;
    }
    if (!latest || position.at > latest.at) latest = { index: episode.index, time: position.time, at: position.at };
  }
  if (latest) return { index: latest.index, time: latest.time };
  if (lastFinished > 0 && lastFinished < series.episodes.length) return { index: lastFinished + 1, time: 0 };
  return { index: 1, time: 0 };
}

/** 0–1 of an episode watched, for the bar under its card; 0 when unknown. */
export function watchedFraction(position: PlaybackPosition | undefined): number {
  if (!position || !(position.duration > 0)) return 0;
  return Math.min(1, Math.max(0, position.time / position.duration));
}

/**
 * SubRip to WebVTT.
 *
 * The two formats differ in exactly the ways handled here: the header, the
 * decimal separator in timestamps, and a handful of tags SubRip files carry
 * that a VTT parser shows as literal text — `<font>`, ASS-style `{\an8}`
 * positions, and the "X1: Y1:" coordinate suffix some rippers write after the
 * arrow line. Cue numbers are legal VTT identifiers and are kept. A file that
 * is already VTT passes through with its header intact.
 */
export function srtToVtt(text: string): string {
  const body = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (/^WEBVTT\b/.test(body)) return body;
  const converted = body
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .replace(/(-->\s*\d{1,2}:\d{2}:\d{2}\.\d{3})[ \t]+X1:\d+[ \t]+X2:\d+[ \t]+Y1:\d+[ \t]+Y2:\d+/g, "$1")
    .replace(/<\/?font[^>]*>/gi, "")
    .replace(/\{\\[^}]*\}/g, "");
  return `WEBVTT\n\n${converted.trim()}\n`;
}

/**
 * A name the player will take as a subtitle file.
 *
 * The two text formats `subtitleToVtt` can actually convert, and no more. A
 * player that accepted `.ass` and then showed an empty track would be worse
 * than one that says which formats it reads — see `subtitleFileRefusal`.
 */
export function isSubtitleFileName(name: string): boolean {
  return SUBTITLE_EXTENSIONS.includes(extensionOf(name));
}

/** Why a file was not taken as subtitles, in words that name the fix. */
export function subtitleFileRefusal(name: string): string {
  const extension = extensionOf(name);
  if (extension === ".ass" || extension === ".ssa") {
    return `${name} is Advanced SubStation, which carries positioning and styling this player cannot convert. Save it as SubRip (.srt) — VLC and Subtitle Edit both export one.`;
  }
  if (extension === ".sub" || extension === ".idx") {
    return `${name} is a bitmap subtitle: pictures of text, not text, so there is nothing to show as a caption. A .srt or .vtt of the same subtitles will work.`;
  }
  return `${name} is not a subtitle file this player reads. Drop an .srt or a .vtt.`;
}

/** The text a subtitle sidecar holds, as WebVTT, whichever of the two it was. */
export function subtitleToVtt(text: string, path: string): string {
  return extensionOf(path) === ".vtt" ? (text.replace(/^﻿/, "").startsWith("WEBVTT") ? text : `WEBVTT\n\n${text}`) : srtToVtt(text);
}
