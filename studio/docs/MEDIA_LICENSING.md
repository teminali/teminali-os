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

**Updated 2026-09-11. The recipe has been run end to end on macOS (arm64), and
both §6 obligations that were outstanding are now met — the About surface names
what ships, and the source offer resolves. The bundle may ship. The ffmpeg half
is built, measured and self-contained; mpv is deliberately not staged, for a
reason worth reading before anyone "fixes" it.**

Done, and verified by the suite:

- **The encoder call sites no longer name a GPL encoder** — see the section
  below, which is now a record rather than a warning.
- **Both finders prefer the bundled copy.** `findMpv`
  (`electron/mpvProcess.cjs`) always did. `findFfmpeg`
  (`electron/mediaAccess.cjs`) now probes `FFMPEG_PATH`, then
  `<Resources>/ffmpeg/ffmpeg`, then `fixedFfmpegDirs()`, then `PATH` — the same
  four-step shape. So does `findBinary` in `server/media-probe.js`, which is a
  second, independent finder that had searched `PATH` first; the player and the
  exporter resolving different ffmpegs is a bug with no symptom until a
  customer meets it.
- **The installer entries exist.** `electron-builder.yml` copies
  `media-stack/ffmpeg` and `media-stack/mpv` to `<Resources>/`. They are
  committed empty, so a build made without the build script warns about
  nothing and ships no bundle — which is exactly what v0.0.6 did.
- **`scripts/build-media-stack.sh`** is the recipe below, executable.
  `npm run build:media-stack`, run by the release workflow before packaging.

Done, and measured by a real build rather than argued from the spec:

- **The sources are pinned.** All four checksums are filled in. ffmpeg's
  tarball was verified against its upstream GPG signature — a good signature
  from the FFmpeg release signing key, fingerprint
  `FCF986EA15E6E293A5644F10B4322F04D67658D8`, matching the key published on
  ffmpeg.org. The other three publish no checksum upstream, so those are
  measured from the canonical host; two of them are GitHub *archive* tarballs,
  which GitHub has regenerated before, so a mismatch there means re-verify
  rather than assume the worst.
- **The ffmpeg bundle is 22 MB** — `ffmpeg`, `ffprobe`, nine `.dylib`s and the
  licence texts — and it starts and encodes with the build tree deleted. Both
  encoders were exercised: `libopenh264` (software) and `h264_videotoolbox`
  (hardware) each wrote a real file. `License: LGPL version 2.1 or later`, read
  off the configure summary.
- **The component set it drops is recorded below**, read off the build rather
  than guessed, along with the check that the app asks for none of it.

Not done:

- **mpv is built but not staged, and that is the script's own decision.** mpv
  0.39 hard-requires libplacebo and libass — `meson.build` takes both
  unconditionally, there is no switch — and this script builds neither, so
  meson links the build machine's copies. Bundling those would mean shipping
  fourteen libraries at whatever version Homebrew had that morning, and a
  source offer has to name a version. So `stage_closure` refuses to copy any
  library this script did not build, `verify_bundle` then sees mpv pointing off
  the machine, and `media-stack/mpv` is left empty — which is exactly what
  every release up to v0.0.6 shipped. **Finishing mpv means pinning and
  building libplacebo, libass and libass's own closure (freetype, fribidi,
  harfbuzz) here.** Until then the player falls back to a system mpv as before.
- **No release builds the bundle yet, and that is currently the right state.**
  `.github/workflows/release.yml` runs `npm run build:media-stack` with
  `continue-on-error: true`, but the runner installs no `meson`, `ninja` or
  `nasm` — so the script stops at its tool gate and the job ships no bundle,
  exactly as v0.0.6 did. Adding those three to the workflow is one line, and it
  is the step that turns "we build an LGPL ffmpeg" into "we distribute one" —
  which is why it was gated on every §6 obligation below being met. As of
  2026-09-11 they are, so the gate is clear and the line is a decision about
  what the next release should carry, not a licence question.
- **Windows has no recipe.** The script exits 0 on Windows with a warning
  rather than failing the job: a Windows release with no media stack is
  v0.0.6's behaviour, and failing would trade away the first Windows build this
  project ever shipped for a bundle it has never had. The route is
  msys2/mingw-w64.
- **The About surface exists** (2026-09-11). **Settings › About** —
  `src/components/settings/AboutPane.tsx` over `GET /api/about`
  (`server/about.js`) — names every bundled component with its version and
  licence, states the written offer beside a link to it, and renders each
  shipped licence text in place. It reads the `manifest.json` the build script
  wrote *beside the binaries*, never a list kept by hand, so it cannot describe
  a different ffmpeg from the one the app spawns. A build with no bundle says
  so rather than claiming one. Covered by `tests/about.test.mjs` (11 tests) and
  one gateway route test.
- **The source offer resolves** (2026-09-11).
  `https://github.com/teminali/releases/releases/tag/media-stack-7.1.1` — the
  URL `manifest.json` has always carried — now exists and answers 200. It holds
  the four pinned tarballs under the names the table below uses, FFmpeg's
  upstream `.asc` signature and signing key, and `build-media-stack.sh` itself:
  seven assets, 75 MB. The SHA-256 of each is in the release notes and is the
  same value the script checks its download against. Marked `--latest=false`,
  which matters: `checkForUpdate` runs `gh release view` with no tag, so a
  `media-stack-*` release taken as "latest" would show every install a release
  that is not a version of the app. Verified after publishing — `gh release
  view --repo teminali/releases` still answers `v0.0.6`, and `listReleases`
  filters the tag out on its own because `parseVersion("media-stack-7.1.1")`
  is null.
- **All three §6 obligations are now met**, so the licence no longer stands in
  the way of shipping the bundle. **A build problem now does**, and it is not
  the one-line change earlier notes promised.
- **CI cannot ship this bundle to macOS until it is universal — measured
  2026-09-11.** `release.yml` builds macOS as `--mac --arm64 --x64`: one arm64
  runner producing *both* app bundles. `extraResources` copies the same
  `media-stack/ffmpeg` into each, and what this script builds is **arm64 only**
  (`lipo -archs media-stack/ffmpeg/ffmpeg` → `arm64`). So an Intel Mac would
  receive an arm64 ffmpeg, and `findFfmpeg` prefers the bundled copy over
  `PATH` — the file exists, so it is selected, and then cannot exec. Export and
  transcode would break for every x64 user **where they work today** via a
  system ffmpeg. Adding `meson`/`ninja`/`nasm` to the runner without fixing
  this ships that regression.

  The fix is a universal binary: build the closure twice, once per arch, and
  `lipo -create` each Mach-O before staging — `verify_bundle` should then also
  assert both architectures are present. Until that exists the workflow's
  media-stack step stays as it is: it runs, stops at the tool gate, and ships
  no bundle, exactly as v0.0.6 did. **Do not add the toolchain to the macOS
  runner as a one-line change.** Linux (`--linux --x64`, built on an x64
  runner) has no such mismatch, but that recipe has never been run anywhere, so
  it is unproven rather than known-good.

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

## What LGPL costs, and it is only the encoders — settled 2026-09-11

`libx264` and `libx265` are GPL-only, and five call sites named one of them
outright. Against an LGPL FFmpeg every one was `Unknown encoder`.

**No call site names an encoder any more.** They state what they want — a
quality, a speed, whether latency matters — and the encoder is decided against
what the ffmpeg that will actually run has:

| File | What it asks for | Hardware? |
| --- | --- | --- |
| `electron/exportFilters.cjs` | the export's codec, CRF 18 or a bitrate | yes, when asked |
| `electron/workspaceMedia.cjs` | playback transcode, CRF 23 veryfast | no |
| `electron/liveStreamer.cjs` | the test broadcast, and the live encode | no |
| `electron/screenRecorder.cjs` | the take that cannot be stream-copied | no |
| `electron/mediaAccess.cjs` | the workspace filtergraph pass, CRF 16 | no |

The policy is `electron/hardwareEncoder.cjs` (pure, and the only table) and the
probe is `electron/encoderProbe.cjs` (one `ffmpeg -encoders` per binary, cached).
`server/media-probe.js` stays pure and free of encoder names: its caller passes
the line in, and it throws rather than defaulting, because a default is a line
that works on a developer's machine and fails on a customer's.

Order: hardware when the caller allows it and it exists, then `libx264`, then
`libopenh264`. **x264 stays first on purpose** — an existing install with a
Homebrew ffmpeg encodes exactly as it did, at the quality it did. Invoking a
GPL encoder inside an ffmpeg the *user* installed is not a licence problem: we
neither ship nor link it.

The replacements, both LGPL-clean and both built by the script:

- **libopenh264** (Cisco, BSD-2) for software H.264.
- **kvazaar** (LGPL-2.1) for software HEVC. SVT-HEVC is the BSD alternative but
  needs an FFmpeg patch to reach; kvazaar is in mainline.

**Two things the original rule did not anticipate**, both found while doing it:

1. **The name is not the hard part; the flags are.** `-preset`, `-crf` and
   `-tune` are x264/x265 *private* options. openh264 has no constant-quality
   mode at all and ffmpeg fails the run on an option it does not recognise
   rather than ignoring it. A swap that changed only the encoder name would
   still have died. `videoEncoderArgs` translates the intent per family, and a
   CRF request becomes a bitrate scaled by quality and frame height.
2. **Deciding by capability rather than by licence removes the ordering
   hazard.** The rule above — bundle and swap in the same turn — existed
   because a half-done swap breaks export. Probing means both halves are safe
   alone: this code runs correctly today against a GPL Homebrew ffmpeg, and
   will run correctly against the LGPL bundle the day one exists.

What is still true: **there is no VAAPI entry for Linux**, so a Linux machine
with no hardware encoder gets software — which is now openh264, not nothing. An
HEVC request that no encoder can satisfy degrades to H.264 (and drops the
`hvc1` tag, which on an H.264 stream is a file QuickTime opens and cannot play)
rather than failing.

## What the LGPL build actually contains — measured 2026-09-11

Read off `ffmpeg-configure.log` from the real build, not from the spec. macOS
arm64, ffmpeg 7.1.1, `License: LGPL version 2.1 or later`.

External libraries, and this is the whole list: `avfoundation`, `coreimage`,
`iconv`, `zlib`, `bzlib`, `libopenh264`, `libkvazaar`.

Video encoders: `h264_videotoolbox`, `hevc_videotoolbox`, `libopenh264`,
`libkvazaar`, `prores` (`_aw`, `_ks`, `_videotoolbox`), `mpeg4`, `msmpeg4v2`,
`msmpeg4v3`. Audio: `aac`, `aac_at`, `alac`, `alac_at`, `flac`, `opus`,
`vorbis`, `pcm_s16le`.

**What a Homebrew GPL ffmpeg has and this one does not:**

| Missing | Because | Costs us |
| --- | --- | --- |
| `libx264`, `libx265` | GPL — the point of the exercise | nothing; `libopenh264` and `libkvazaar` replace them |
| `drawtext` | no libfreetype | nothing — no call site draws text with ffmpeg |
| `subtitles`, `ass` | no libass | nothing — subtitles are rendered by mpv, not burned in |
| `zscale` | no zimg | nothing — `scale` is used everywhere |
| `libmp3lame` | GPL-adjacent and unbundled | no MP3 *encoding*; the decoder is native and unaffected |
| `libvpx`, `libaom` | not built | no VP9/AV1 *encoding*; decoding is native |
| `metal` | dropped by `--disable-autodetect` | nothing — its only user is the videotoolbox deinterlace filter |
| SDL2, libxcb, libX11 | autodetected on the first run | nothing; they were never useful on a Mac |

**The application asks for none of it.** Checked by grep across
`electron/*.cjs` and `server/media-probe.js`: no `drawtext`, no `subtitles=`,
no `zscale`, no `yadif`, no MP3 encode. The `mp3` strings in
`server/media-probe.js` are probe and decode paths, which are native to ffmpeg
and unaffected.

The lesson worth keeping is the one that cost two rebuilds: **an autodetecting
build absorbs the machine it is built on.** The first run linked Homebrew's
SDL2 and libX11 into ffmpeg, and Homebrew's librubberband — GPL-2.0-or-later —
into mpv, because mpv's meson options default to `auto` and `-Dgpl=false`
governs mpv's own source rather than what it links. Both halves now state every
optional dependency; `tests/media-stack-recipe.test.mjs` asserts they keep
doing so.

## What has to ship beside the binaries

LGPL-2.1 §6 asks that the user be able to replace the library with their own
build. Three things satisfy it, and all three are release-time work:

1. **The library is dynamically linked and replaceable.** A `.dylib`/`.dll`/
   `.so` beside the app, not statically linked into it. This is why B3's macOS
   step links `libmpv` rather than vendoring mpv's objects.
2. **The licence texts ship with the app**, and the About surface names mpv,
   FFmpeg, libass and each LGPL dependency with its version. The texts now
   ship: `media-stack/ffmpeg/licences/` carries FFmpeg's `COPYING.LGPLv2.1`,
   openh264's `LICENSE` and kvazaar's `LICENSE`, and each copy is checked
   rather than attempted. It was not always three — the first version looked
   for kvazaar's licence at `COPYING`, which that tarball does not have, and
   ended the line with `|| true`, so the bundle shipped no kvazaar licence and
   said nothing. **The About surface now exists** (2026-09-11) and is what
   turned this from prepared-for into met: `settings/AboutPane.tsx` lists the
   components off the manifest and reads each text out of `licences/` through
   `GET /api/about/licence`. It lists that directory rather than enumerating
   it, so a component the build stops shipping stops being named, and a
   licence file that never got copied cannot be silently implied by a
   hard-coded row.
3. **The corresponding source is offered** — the exact tarballs and the build
   script that produced the shipped binaries, at a URL that outlives the
   release. Our own source stays closed; the offer covers the LGPL libraries
   only. **Decided 2026-09-11:** a `media-stack-<ffmpeg version>` release in
   `teminali/releases`, the repository the app's own releases already ship
   from, carrying the four pinned tarballs and this script. `manifest.json`
   records that URL, the About pane shows it, and `MEDIA_STACK_SOURCE_OFFER`
   overrides it. **Created 2026-09-11** with the four tarballs, FFmpeg's
   upstream signature and signing key, and the build script — the last of the
   three obligations to be met. Re-cut it whenever a pin in the script changes:
   the offer names versions, so a bumped pin without a new release is an offer
   for source we no longer ship.

## Where the files land

`<Resources>/mpv/mpv` (`mpv.exe` on Windows) and `<Resources>/ffmpeg/ffmpeg`
alongside `ffprobe` — the paths both finders probe first. Each
`electron-builder.yml` entry has its own `to:`; an entry written above
another's silently takes it, which is the trap that block's own comment
documents.

Staged from `media-stack/ffmpeg` and `media-stack/mpv`, which the build script
fills and `.gitignore` keeps out of the repository. Each directory carries its
own copy of the shared-library closure rather than sharing one: they both need
`libav*`, and the duplication is cheaper than a resolution order that breaks
the first time one of the two moves.

Measured on macOS arm64: **`media-stack/ffmpeg` is 22 MB** — `ffmpeg`,
`ffprobe`, nine `.dylib`s, `licences/` and `manifest.json`. `media-stack/mpv`
is empty, for the reason in Status above.

**`manifest.json` is written into each staged directory as well as at the top
of `media-stack/`.** The two `extraResources` entries copy directories, so a
manifest that lived only at the top would never reach `<Resources>` and the
About surface could not read it. Putting it inside needs no third entry — and a
third entry would name a generated file, which would break packaging on any
machine that has not run the build script. Keeping those entries safe to build
without is the whole reason the directories are committed empty.

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
