/*
  A folder, read as a gallery — and, when it holds videos, as a series.

  Everything here is a pure function over the tree the sidebar already holds,
  which is the point: the gallery cannot disagree with the Explorer, because
  they are the same data. What is worth pinning is the ordering (a naive sort
  puts episode 10 before episode 2), the sidecar matching (a language suffix
  must not swallow a different file's name), the resume rule, and the SubRip
  conversion, which is the one place a format is being rewritten rather than
  read.
*/
import test from "node:test";
import assert from "node:assert/strict";

import {
  describeGallery, entryKind, episodeCode, episodeTitle, findTreeNode, galleryOf, isOpenable,
  isSeriesFolder, isSubtitleFileName, naturalCompare, resumePoint, seriesOf, srtToVtt,
  subtitleFileRefusal, subtitleToVtt, subtitleTracksFor, watchedFraction,
  SERIES_MIN_EPISODES, WATCHED_RATIO,
} from "../src/services/workspaceGallery.ts";
import { SERIES_MIN_EPISODES as GATEWAY_MIN, isVideoWorkspaceFile } from "../server/workspace.js";

function file(name, extra = {}) {
  return { id: `f:${name}`, name, path: `Show/${name}`, type: "file", size: 1024, ...extra };
}

function folder(name, children) {
  return { id: `d:${name}`, name, path: name, type: "directory", children };
}

test("the gateway and the pane draw the series line at the same number", () => {
  // A folder one side opens as a series and the other refuses is a tool that
  // lies about what the operator is looking at.
  assert.equal(SERIES_MIN_EPISODES, GATEWAY_MIN);
});

test("a folder of videos is a series; one video is a folder", () => {
  const show = folder("Show", [file("Episode 1.mp4"), file("Episode 2.mkv"), file("notes.md")]);
  const series = seriesOf(show);
  assert.ok(series);
  assert.equal(series.episodes.length, 2);
  assert.ok(isSeriesFolder(show));

  assert.equal(seriesOf(folder("Show", [file("Episode 1.mp4"), file("notes.md")])), null);
  assert.equal(seriesOf(folder("Show", [file("song.mp3"), file("song2.mp3")])), null, "audio is not a series");
});

test("subfolders are not descended: a season is its own series", () => {
  const show = folder("Show", [
    { id: "d:s1", name: "Season 1", path: "Show/Season 1", type: "directory", children: [file("a.mp4"), file("b.mp4")] },
  ]);
  assert.equal(seriesOf(show), null);
});

test("episode 10 sorts after episode 2, which a plain sort gets wrong", () => {
  const show = folder("Show", [file("Episode 10.mp4"), file("Episode 2.mp4"), file("Episode 1.mp4")]);
  assert.deepEqual(seriesOf(show).episodes.map((episode) => episode.name), ["Episode 1.mp4", "Episode 2.mp4", "Episode 10.mp4"]);
  assert.ok(naturalCompare("Episode 2", "Episode 10") < 0);
});

test("the episode number is read from the name in the shapes files actually use", () => {
  assert.equal(episodeCode("Show.S01E04.1080p.mkv"), "S01E04");
  assert.equal(episodeCode("Show s2 e7.mp4"), "S02E07");
  assert.equal(episodeCode("Episode 12 - The Fall.mp4"), "12");
  assert.equal(episodeCode("03 The Fall.mp4"), "03");
  assert.equal(episodeCode("Part 4.mp4"), "04");
  assert.equal(episodeCode("holiday footage.mp4"), null);
});

test("a title is the file name made readable, and nothing cleverer", () => {
  assert.equal(episodeTitle("The.Fall.1080p.WEB.mkv"), "The Fall 1080p WEB");
  assert.equal(episodeTitle("my_holiday_video.mp4"), "my holiday video");
  // Guessing which words are noise gets it wrong more often than a long title does.
  assert.equal(episodeTitle("Episode 1.mp4"), "Episode 1");
});

test("a sidecar matches on the base name, with or without a language", () => {
  const video = file("Episode 1.mp4");
  const siblings = [
    video,
    file("Episode 1.srt"),
    file("Episode 1.es.srt"),
    file("Episode 1.pt-BR.vtt"),
    file("Episode 10.srt"),
    file("Episode 1.txt"),
  ];
  const tracks = subtitleTracksFor(video, siblings);
  assert.deepEqual(tracks.map((track) => track.path).sort(), [
    "Show/Episode 1.es.srt", "Show/Episode 1.pt-BR.vtt", "Show/Episode 1.srt",
  ]);
  // The exact match leads, because it is the one with no language to name.
  assert.equal(tracks[0].path, "Show/Episode 1.srt");
  assert.equal(tracks[0].label, "Subtitles");
  // "Episode 10.srt" must not attach to "Episode 1.mp4".
  assert.ok(!tracks.some((track) => track.path.includes("Episode 10")));
});

test("a language tag becomes a name where the runtime knows one", () => {
  const video = file("Ep.mp4");
  const [track] = subtitleTracksFor(video, [video, file("Ep.en.srt")]);
  assert.match(track.label, /English/i);
});

test("resume picks the one left in the middle, then the one after the last finished", () => {
  const show = folder("Show", [file("1.mp4"), file("2.mp4"), file("3.mp4")]);
  const series = seriesOf(show);

  assert.deepEqual(resumePoint(series, {}), { index: 1, time: 0 }, "nothing watched starts at the first");

  const halfway = { "Show/2.mp4": { time: 300, duration: 1000, at: 5 } };
  assert.deepEqual(resumePoint(series, halfway), { index: 2, time: 300 });

  const finishedTwo = {
    "Show/1.mp4": { time: 1000, duration: 1000, at: 1 },
    "Show/2.mp4": { time: 995, duration: 1000, at: 2 },
  };
  assert.deepEqual(resumePoint(series, finishedTwo), { index: 3, time: 0 });

  const allDone = {
    "Show/1.mp4": { time: 1000, duration: 1000, at: 1 },
    "Show/2.mp4": { time: 1000, duration: 1000, at: 2 },
    "Show/3.mp4": { time: 1000, duration: 1000, at: 3 },
  };
  assert.equal(resumePoint(series, allDone).index, 1, "a finished series starts over rather than pointing past the end");
});

test("watched is a fraction, and an unknown duration is not a division by zero", () => {
  assert.equal(watchedFraction(undefined), 0);
  assert.equal(watchedFraction({ time: 50, duration: 0, at: 1 }), 0);
  assert.equal(watchedFraction({ time: 50, duration: 100, at: 1 }), 0.5);
  assert.equal(watchedFraction({ time: 400, duration: 100, at: 1 }), 1, "past the end is still 1");
  assert.ok(WATCHED_RATIO > 0.5 && WATCHED_RATIO < 1);
});

test("a node is found anywhere in the tree, and a wrong branch is not walked", () => {
  const tree = [folder("Show", [file("1.mp4")]), folder("Other", [{ id: "x", name: "deep", path: "Other/deep", type: "directory", children: [] }])];
  assert.equal(findTreeNode(tree, "Show/1.mp4").name, "1.mp4");
  assert.equal(findTreeNode(tree, "Other/deep").type, "directory");
  assert.equal(findTreeNode(tree, "Nowhere/x.mp4"), null);
});

test("SubRip becomes WebVTT: header, decimal comma, and the tags a VTT parser would show as text", () => {
  const srt = "1\n00:00:01,000 --> 00:00:04,500  X1:0 X2:100 Y1:0 Y2:20\n{\\an8}<font color=\"#fff\">Hello</font>\n\n2\n00:00:05,250 --> 00:00:06,000\nAgain\n";
  const vtt = srtToVtt(srt);
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:04\.500\n/);
  assert.ok(!vtt.includes("X1:"), "the coordinate suffix would break the cue line");
  assert.ok(!vtt.includes("<font"), "a font tag would be shown as literal text");
  assert.ok(!vtt.includes("{\\an8}"));
  assert.match(vtt, /Hello/);
  assert.match(vtt, /00:00:05\.250/);
});

test("a file that is already WebVTT passes through, and a .vtt with no header gets one", () => {
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n";
  assert.equal(srtToVtt(vtt), vtt);
  assert.equal(subtitleToVtt(vtt, "a.vtt"), vtt);
  assert.match(subtitleToVtt("00:00:01.000 --> 00:00:02.000\nHi\n", "a.vtt"), /^WEBVTT\n/);
  assert.match(subtitleToVtt("1\n00:00:01,000 --> 00:00:02,000\nHi\n", "a.srt"), /^WEBVTT\n/);
});

test("the gateway agrees about which extensions are video", () => {
  // The renderer decides a folder is a series; the gateway decides the same
  // thing for `open_file`. They must count the same files.
  for (const name of ["a.mp4", "a.mkv", "a.avi", "a.mov", "a.webm", "a.wmv"]) {
    assert.ok(isVideoWorkspaceFile(name), name);
    assert.ok(seriesOf(folder("S", [file(name), file(`b${name}`)])), name);
  }
  for (const name of ["a.mp3", "a.flac", "a.txt", "a.ts"]) {
    assert.ok(!isVideoWorkspaceFile(name), name);
  }
});

/* ── Every folder is a gallery ────────────────────────────────────────────── */

test("a card's kind is the viewer behind it, not a mime taxonomy", () => {
  const kinds = {
    "a.mp4": "video", "a.mkv": "video", "a.mp3": "audio", "a.flac": "audio",
    "a.png": "image", "a.jpg": "image", "a.webp": "image",
    "a.pdf": "pdf", "a.xlsx": "sheet", "a.csv": "sheet",
    "a.ts": "text", "a.md": "text", "a.srt": "text", "a.json": "text",
    // Markup an operator is more likely to edit than to look at, exactly as
    // the gateway's reader treats it.
    "a.svg": "text",
    "Dockerfile": "text", ".gitignore": "text", "Makefile": "text",
    "a.zip": "other", "a.bin": "other",
  };
  for (const [name, expected] of Object.entries(kinds)) {
    assert.equal(entryKind(file(name)), expected, name);
  }
  assert.equal(entryKind(folder("Show", [])), "folder");
  assert.equal(isOpenable("other"), false);
  assert.equal(isOpenable("text"), true);
});

test("folders lead, then files, each in the tree's own order", () => {
  const gallery = galleryOf(folder("Mixed", [
    file("b.png"), file("Episode 10.mp4"), folder("zebra", []), file("Episode 2.mp4"), folder("alpha", []),
  ]));
  assert.deepEqual(gallery.entries.map((entry) => entry.name), [
    "alpha", "zebra", "b.png", "Episode 2.mp4", "Episode 10.mp4",
  ]);
});

test("a gallery of videos carries the series, and the cards carry their episode numbers", () => {
  const gallery = galleryOf(folder("Show", [file("Episode 1.mp4"), file("Episode 2.mp4"), file("notes.md")]));
  assert.ok(gallery.series);
  assert.equal(gallery.series.episodes.length, 2);
  const numbered = gallery.entries.filter((entry) => entry.episode !== null);
  assert.deepEqual(numbered.map((entry) => entry.episode), [1, 2]);
  // A document in the same folder is a card like any other, with no number.
  assert.equal(gallery.entries.find((entry) => entry.name === "notes.md").episode, null);
});

test("a folder that is not a series is still a gallery", () => {
  const gallery = galleryOf(folder("Docs", [file("a.pdf"), file("b.md")]));
  assert.equal(gallery.series, null);
  assert.equal(gallery.entries.length, 2);
  assert.equal(galleryOf(file("a.mp4")), null, "a file is not a gallery");
});

test("the header names the biggest groups and folds the tail", () => {
  assert.equal(describeGallery({ folder: 0, video: 0, audio: 0, image: 0, pdf: 0, sheet: 0, text: 0, other: 0 }), "Empty");
  assert.equal(describeGallery({ folder: 0, video: 1, audio: 0, image: 0, pdf: 0, sheet: 0, text: 0, other: 0 }), "1 video");
  assert.equal(
    describeGallery({ folder: 2, video: 14, audio: 0, image: 3, pdf: 0, sheet: 0, text: 0, other: 0 }),
    "14 videos · 3 images · 2 folders",
  );
  // Four kinds or more: three named, the rest counted, because a header
  // listing eight groups is a header nobody reads.
  assert.equal(
    describeGallery({ folder: 1, video: 9, audio: 2, image: 5, pdf: 1, sheet: 1, text: 0, other: 0 }),
    "9 videos · 5 images · 2 audio files · 3 more",
  );
});

test("a subtitle sidecar reaches the card even when the folder is not a series", () => {
  const gallery = galleryOf(folder("One", [file("Talk.mp4"), file("Talk.en.srt")]));
  assert.equal(gallery.series, null);
  const video = gallery.entries.find((entry) => entry.name === "Talk.mp4");
  assert.equal(video.subtitles.length, 1);
});

test("a folder card says how many children the tree knows about", () => {
  const gallery = galleryOf(folder("Top", [folder("Inner", [file("a.mp4"), file("b.mp4")])]));
  assert.equal(gallery.entries[0].children, 2);
});

test("a folder keeps its own name in the header and on its card", () => {
  // `episodeTitle` tidies a file name into a caption. A folder is a thing on
  // disk the operator named, and the tree shows it as it is; the gallery must
  // not quietly rename it.
  const show = folder("Breaking.Bad_S01", [file("1.mp4"), file("2.mp4")]);
  assert.equal(galleryOf(show).title, "Breaking.Bad_S01");
  assert.equal(seriesOf(show).title, "Breaking.Bad_S01");
  assert.equal(galleryOf(folder("Top", [folder("node_modules", [])])).entries[0].title, "node_modules");
});

test("a restored panel of a kind this build dropped does not come back", async () => {
  /*
    Source-text, in the style of tests/responsive-layout.test.mjs, because the
    migration lives inside a zustand `persist` config that cannot be loaded
    under node. It is worth pinning all the same: the gallery was called
    "series" for an afternoon, and anyone who ran that build has a stored tab
    of a kind this one has no pane for. Filtering against the live kind set
    rather than a list of dead names is what makes the next rename harmless,
    so a regression to `kind !== "recorder"` is the thing to catch.
  */
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/store/panelStore.ts", import.meta.url), "utf8");
  assert.match(source, /const known = new Set\(Object\.keys\(PANEL_DEFAULTS\)\);/);
  assert.match(source, /panels = state\.panels\.filter\(\(panel\) => known\.has\(panel\.kind\)\)/);
  assert.match(source, /version: 3,/, "a migration nobody's stored state is old enough to run is not a migration");
  assert.doesNotMatch(source, /kind !== "recorder"/);
});

test("the player takes the two subtitle formats it can actually convert", () => {
  for (const name of ["a.srt", "A.SRT", "Episode 1.en.vtt"]) {
    assert.ok(isSubtitleFileName(name), name);
  }
  for (const name of ["a.ass", "a.ssa", "a.sub", "a.idx", "a.mp4", "notes.txt"]) {
    assert.equal(isSubtitleFileName(name), false, name);
  }
});

test("a subtitle file that is refused says which format it is and what to do", () => {
  /*
    A player that accepted an .ass and then showed an empty track would be
    worse than one that will not take it: the operator would be debugging the
    file. Each refusal names the format and the way out.
  */
  assert.match(subtitleFileRefusal("show.ass"), /Advanced SubStation/);
  assert.match(subtitleFileRefusal("show.ass"), /\.srt/);
  assert.match(subtitleFileRefusal("show.sub"), /bitmap/);
  assert.match(subtitleFileRefusal("show.mp4"), /Drop an \.srt or a \.vtt/);
});

test("the player leaves the window's bottom-right corner to the shared chrome that owns it", async () => {
  /*
    The version control is `fixed bottom-2 right-3` at z-40, above anything a
    panel draws. The video editor's timeline has always reserved that strip;
    the player is the second pane to draw content that far down, and it was
    reported as the version pill sitting on top of the fullscreen button.

    Source-text, like the panel-migration test above: the reservation is a
    style on a rendered div, and what is worth catching is someone deleting it
    or applying it in fullscreen too — where there is no app chrome to avoid,
    because a fullscreen element is rendered alone.
  */
  const { readFile } = await import("node:fs/promises");
  const player = await readFile(new URL("../src/components/workspace/panels/MediaPlayer.tsx", import.meta.url), "utf8");
  const badge = await readFile(new URL("../src/components/updates/VersionControl.tsx", import.meta.url), "utf8");

  assert.match(badge, /fixed bottom-2 right-3 z-40/, "the strip this reserves is the one the badge occupies");
  assert.match(player, /const VERSION_BADGE_STRIP = \d+;/);
  assert.match(player, /paddingRight: fullscreen \? undefined : VERSION_BADGE_STRIP/);
});
