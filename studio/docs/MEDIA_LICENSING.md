# The media stack's licence

**Decision, 2026-09-10 (the plan's B0): Teminali OS ships LGPL builds of mpv
and of FFmpeg, made here.** Not the distributions' GPL packages, not a
third party's prebuilt binary.

This document is the recipe and the obligations. The *reasoning* is in
`DESIGN.md` §3, "The licence is LGPL, and that is what makes B3 possible" — in
one line: on macOS no process can embed another process's window, so B3 ends
in a linked `libmpv` on the Mac whatever it starts as, and linking a GPL
`libmpv` would make this product — which is sold, and closed — GPL. LGPL is the
only shape that does not have to be chosen twice.

## Status

**Nothing is bundled yet, and the two are not equally ready.**

- **mpv is a file drop.** `findMpv` (`electron/mpvProcess.cjs:128`) probes
  `<Resources>/mpv/` ahead of the install directories, so shipping it needs an
  `electron-builder.yml` entry and no code change. Nothing puts a file there
  today, and on a clean machine it returns null.
- **ffmpeg is not.** `findFfmpeg` (`electron/mediaAccess.cjs:129-146`) probes
  `FFMPEG_PATH`, then `fixedFfmpegDirs()`, then `PATH` — there is **no bundled
  branch**. Bundling it means adding one, in the same shape, before the
  installer entry is worth writing.

The builds below have **not been produced or measured**; this is the
specification for the turn that first produces them.

## What to build

### mpv

Meson, with GPL code compiled out:

```bash
meson setup build -Dgpl=false -Dlibmpv=true
```

`-Dgpl=false` is mpv's own LGPLv2.1 mode. It requires an FFmpeg that is itself
LGPL — an mpv built this way against a GPL FFmpeg is still a GPL binary, and
nothing warns you. `-Dlibmpv=true` builds the shared library as well as the
player: Windows and Linux spawn the executable, macOS links the library
(below), and both come out of one build.

The exact set of components `-Dgpl=false` drops must be **read off the build
log and recorded here** rather than guessed — broadly it is the GPL-only
optional inputs and the GPL half of libavfilter, none of which the player
touches. What matters is what survives, and playback does: the decoders are
LGPL FFmpeg's, `libass` is ISC, and the plan's acceptance case — HEVC video,
DTS audio, embedded ASS subtitles — is untouched.

### FFmpeg

```bash
./configure --enable-shared --disable-static --enable-libopenh264 ...
```

No `--enable-gpl`, and no `--enable-nonfree` — that second one is not a licence
at all and cannot be distributed under any terms.

## What LGPL costs, and it is only the encoders

`libx264` and `libx265` are GPL-only. They are the software encode fallback in
five places today:

| File | Line | Encoder |
| --- | --- | --- |
| `server/media-probe.js` | 256 | `libx264` |
| `electron/exportFilters.cjs` | 51 | `libx265` / `libx264` |
| `electron/liveStreamer.cjs` | 89, 176 | `libx264` |
| `electron/screenRecorder.cjs` | 438 | `libx264` |
| `electron/mediaAccess.cjs` | 192 | `libx264` |

Against an LGPL FFmpeg every one of those is `Unknown encoder`. Hardware covers
most real machines — `electron/hardwareEncoder.cjs` already prefers
VideoToolbox on macOS and NVENC/QSV/AMF on Windows — but there is no VAAPI
entry for Linux, and a machine with no hardware encoder would be left with no
encoder at all. That is a regression waiting in the turn that swaps the binary,
not a problem for playback.

The replacements, both LGPL-clean:

- **libopenh264** (Cisco, BSD-2) for software H.264.
- **kvazaar** (LGPL-2.1) or **SVT-HEVC** (BSD) for software HEVC.

**Rule: the turn that first bundles an ffmpeg settles this in the same turn.**
Shipping an LGPL ffmpeg while five call sites still name `libx264` turns a
working export into a failing one on exactly the machines that most need the
bundle.

## What has to ship beside the binaries

LGPL-2.1 §6 asks that the user be able to replace the library with their own
build. Three things satisfy it, and all three are release-time work:

1. **The library is dynamically linked and replaceable.** A `.dylib`/`.dll`/
   `.so` beside the app, not statically linked into it. This is why B3's macOS
   step links `libmpv` rather than vendoring mpv's objects.
2. **The licence texts ship with the app**, and the About surface names mpv,
   FFmpeg, libass and each LGPL dependency with its version.
3. **The corresponding source is offered** — the exact tarballs and the build
   script that produced the shipped binaries, at a URL that outlives the
   release. Our own source stays closed; the offer covers the LGPL libraries
   only.

## Where the files land

`<Resources>/mpv/mpv` (`mpv.exe` on Windows) — the path `findMpv` already
probes first. The `electron-builder.yml` entry needs its own `to:`; an entry
written above another's silently takes it, which is the trap that block's own
comment documents.

**A native binary that a shim spawns must also be in `asarUnpack`** —
`tests/asar-unpack.test.mjs` is the guard. An `extraResources` copy is outside
the archive already; a binary reached through `app.asar` is not.

## The ffmpeg question this closes

`docs/WINDOWS_PACKAGING.md` has carried an open decision since 2026-09-07:
ffmpeg is bundled on no platform, every fresh install is told to run a shell
command, and "before bundling, pick the licence". This is that pick, and it is
the same pick — LGPL, both. The two are not redundant: mpv's internal FFmpeg
fixes *playback* on a clean machine, while export, recording and streaming
shell out to the ffmpeg CLI and still need their own copy.
