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

**Updated 2026-09-11. The recipe has been run end to end on macOS and now
produces a universal bundle — `arm64` and `x86_64`, built separately and fused
with `lipo`. Both §6 obligations that were outstanding are met: the About
surface names what ships, and the source offer resolves. The ffmpeg half is
built, measured, self-contained and executable on both architectures; mpv is
deliberately not staged, for a reason worth reading before anyone "fixes" it.
Nothing in the licence or the build stands between this bundle and a release,
and the macOS runner now installs `nasm`: the next tagged release ships it.**

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
- **The ffmpeg bundle is 48 MB** — `ffmpeg`, `ffprobe`, nine `.dylib`s and the
  licence texts, each carrying both architectures — and it starts and encodes
  from a copy made outside the build tree. Both encoders were exercised on
  **both slices**: `libopenh264` (software) and `h264_videotoolbox` (hardware)
  each wrote a real file natively and under Rosetta. `License: LGPL version 2.1
  or later`, read off the configure summary.
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
  every release up to v0.0.7 shipped.

  Since the bundle went universal it is not built on macOS **at all**. Those
  same machine-supplied libraries exist for the native architecture only, so
  there is no second half to fuse against, and a universal bundle cannot carry
  a thin binary — building it would spend minutes on something staging must
  then discard. `MEDIA_STACK_ARCHS=arm64` restores the old behaviour for anyone
  working on it. A consequence worth knowing: mpv is the only thing that needed
  `meson` and `ninja`, so the default macOS build no longer asks for either.

  **Finishing mpv means pinning and building libplacebo, libass and libass's
  own closure (freetype, fribidi, harfbuzz) here**, per architecture. Until
  then the player falls back to a system mpv as before.
- **Only macOS releases carry the bundle; Linux and Windows still ship without
  one.** `.github/workflows/release.yml` installs `nasm` on `macos-latest` and
  nowhere else, so the script runs to completion there and stops at its tool
  gate on the other two, which ship exactly as v0.0.7 did.

  That `if:` is the whole decision, and it is deliberately not a matrix-wide
  one. What it cost had changed twice before it was taken: it was gated on the
  §6 obligations, which are met, and then on the universal-binary defect, which
  is fixed and measured below. It also turned out to be one tool rather than
  three — `meson` and `ninja` only ever built mpv, which a universal macOS
  build no longer builds. Giving Linux the same line is now a smaller decision
  than it was — **that half of the recipe has been run, found broken in three
  ways, fixed, and re-run green on aarch64** (see the last bullet under Status)
  — but not the same one: the runner is `--linux --x64` and the proof is
  aarch64, so the x86 assembler gate is the one thing an x64 run would exercise
  that the aarch64 one could not. Linux also still *builds* mpv and then
  discards it, so it would want `meson` and `ninja` as well as `nasm` — three
  tools for an artifact measured to be refused at staging.

  `continue-on-error: true` stays on that step, so a macOS release whose bundle
  failed to build still publishes and falls back to a system ffmpeg. Because
  that also reports the step as `success`, the workflow has a **Report what the
  media stack produced** step after it: that line, not the step's conclusion,
  is what says whether a bundle shipped and which architectures it carries.
- **Windows has no recipe, and writing one blind is the thing Linux just
  disproved.** The script exits 0 on Windows with a warning rather than failing
  the job: a Windows release with no media stack is v0.0.6's behaviour, and
  failing would trade away the first Windows build this project ever shipped
  for a bundle it has never had. The route is msys2/mingw-w64.

  The Linux account further down this section — under "The macOS bundle is
  universal", which is where that measurement lives — is the argument against
  writing this one from reading. Three of that platform's four faults were
  **silent skips, not errors**: a guard
  that quietly excluded every file, a check that returned success without
  looking, a build that ran its own output. Reading the script predicted one of
  the three. A Windows recipe written without a Windows machine would be wrong
  in the same shape, and `continue-on-error: true` would report it green.

  What can be established from here, and is worth having written down before
  somebody starts:

  - **Windows can carry the bundle already.** The two `media-stack`
    `extraResources` entries in `electron-builder.yml` are global, not inside
    a platform block, so the packaging half needs no change — only the recipe.
  - **There is no relocation step.** The Windows loader searches the
    executable's own directory before anything else, so the DLLs simply sit
    beside `ffmpeg.exe`. There is no `@rpath`, no `$ORIGIN`, and no
    `install_name_tool`/`patchelf` equivalent to run — `relocate` should be a
    no-op there rather than a third branch.
  - **`verify_bundle` still needs a third implementation.** PE records an
    import table, read with `objdump -p` under mingw; the check is that every
    imported DLL is either beside the binary or a genuine system DLL
    (`KERNEL32`, `msvcrt`, …). Without it Windows would be in exactly the
    position Linux was: staging whatever it likes and reporting success.
  - **`is_binary` needs a PE case**, or it excludes every Windows file the same
    way it excluded every ELF one.

  **Prove it on the CI Windows runner before trusting it**, the way Linux was
  proven in a VM. A `workflow_dispatch` run exercises the media-stack step
  without publishing a release, which is the cheapest honest test available for
  a platform nobody here has.
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
- **The macOS bundle is universal — fixed and measured 2026-09-11.**
  `release.yml` builds macOS as `--mac --arm64 --x64`: one arm64 runner
  producing *both* app bundles, with `extraResources` copying the same
  `media-stack/ffmpeg` into each. Until this was fixed the script built
  **arm64 only**, so an Intel Mac would have received an arm64 ffmpeg — and
  `findFfmpeg` prefers the bundled copy over `PATH`, deciding by
  `statSync().isFile()`, so the wrong-architecture binary would exist, win, and
  then fail to exec, taking export and transcode down **where they work today**
  via a system ffmpeg. A bundle like that is worse than no bundle.

  The script now builds the whole closure once per architecture into its own
  prefix, from its own pristine source tree, and `lipo -create`s every Mach-O
  before staging. Three details are load-bearing:

  - **The architecture rides in `CC`, not in `ARCH` and not in `CFLAGS`.**
    openh264's `build/platform-darwin.mk` adds `-arch arm64` for arm64 and
    nothing at all for x86_64, so `make ARCH=x86_64` on an arm64 Mac compiles
    native C and assembles foreign asm. And all three build systems here do
    `CFLAGS +=`; a command-line `CFLAGS=` replaces what they append rather than
    extending it, taking `-fPIC` with it. `CC="clang -arch <arch>"` is the one
    channel all three honour. No cross toolchain is needed — the macOS SDK
    already carries both slices.
  - **Each architecture gets its own extraction**, not a `make clean` between
    passes. openh264 and ffmpeg build in-tree, and a leftover object file from
    the other architecture does not announce itself.
  - **`verify_bundle` asserts every slice, and walks paths per slice.** A fat
    binary missing one fails the build exactly like a thin one; and `otool -L`
    without `-arch` only ever shows the architecture you are standing on, so a
    dependency pointing into the build tree in the *other* slice would ship
    silently. Beyond the headers, the script executes what it built: natively,
    and through Rosetta when it is installed, which is a real test of the
    cross-built half rather than a reading of it.

  Measured on this build: `lipo -archs media-stack/ffmpeg/ffmpeg` → `x86_64
  arm64`; all eleven Mach-O files carry both slices; no path in either slice
  points off the machine; and a copy of the directory moved elsewhere runs, and
  encodes through `libopenh264` and `h264_videotoolbox`, under both
  architectures.

  **Linux has now been run, and it did not work — measured on aarch64 Ubuntu
  24.04, 2026-09-11.** It had never been run anywhere, and "unproven rather
  than known-good" turned out to be generous. The staged `media-stack/ffmpeg`
  held the two executables, **no libraries at all**, no rpath, seven unresolved
  sonames, and did not start; `manifest.json` meanwhile claimed a working mpv.
  Three separate faults, each invisible on macOS:

  1. **Every staging function tested for Mach-O**, which is false for every ELF
     file — so `stage_closure`'s dependency walk and `relocate`'s `patchelf`
     branch skipped every binary they were handed and reported success. The
     test is now `is_binary`, and the platform is in it.
  2. **`verify_bundle` returned 0 on anything but macOS** — a check that passed
     by declining to look, which is the one failure it exists to prevent. It
     now walks recorded `SONAME`s and requires an `$ORIGIN` rpath. It reads the
     headers rather than asking `ldd`, deliberately: `ldd` answers for the
     build machine, so an mpv linking the box's libplacebo would resolve
     cleanly there and ship broken to everyone else — the same "absorbs the
     build machine" trap the configure flags close, one layer down.
  3. **mpv's build runs the mpv it just built** (`TOOLS/gen-mpv-desktop.py`
     asks it for its protocol list) and ELF resolves `libopenh264.so.7` through
     the runtime linker, not by the absolute path Mach-O records. The build
     died at the desktop-file step after compiling every object. `LD_LIBRARY_PATH`
     now points at the prefix for that step on non-macOS.

  A fourth, shared with macOS: the `nasm` gate was unconditional, and nasm
  assembles x86 SIMD only. It refused an aarch64 build that then completed
  without nasm ever being installed. The gate is now taken only when a target
  architecture is x86.

  **After those four, Linux is proven on aarch64**: nine libraries staged,
  `$ORIGIN` rpath, zero unresolved sonames, and a copy moved out of the build
  tree runs and encodes through `libopenh264` with `LD_LIBRARY_PATH` unset.
  mpv is refused there exactly as on macOS, naming `libass.so.9` and
  `libplacebo.so.338`, and no longer appears in the manifest.

  **What is still unproven is x86_64 Linux specifically.** The run above was
  aarch64, because that is what a VM on an Apple Silicon Mac gives you; the CI
  runner is `--linux --x64`. The ELF path is the same code, and the nasm gate
  now takes effect there where it did not on aarch64, so that is the one
  difference an x64 run would exercise that this one could not.

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

Read off `ffmpeg-configure-arm64.log` from the real build, not from the spec.
macOS, ffmpeg 7.1.1, both architectures. The two configures were compared in
`config.h` rather than assumed equal: `GPL 0`, `NONFREE 0`, `LIBOPENH264 1`,
`LIBKVAZAAR 1` and `VIDEOTOOLBOX 1` on each, and both binaries report the GNU
Lesser General Public License when asked with `ffmpeg -L`.

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

## The JavaScript side will have a licence too — mediabunny, MPL-2.0

**Not yet true: nothing below ships in 0.0.8.** Recorded here 2026-09-11 so the
obligation is known before it attaches, not discovered at a release.

`DESIGN.md` §3, "Export throughput: the seek is the render", commits the export
rewrite to decoding through WebCodecs rather than seeking a `<video>` element.
The library that provides that — `VideoSampleSink.samplesAtTimestamps()` — is
**mediabunny 1.56.1, MPL-2.0**: pure TypeScript, no WASM, no native module, no
runtime dependencies beyond `@types/*` for the WebCodecs DOM definitions, 673 KB
minified for the browser bundle.

It is an npm dependency, not a binary in `media-stack/`, so none of the LGPL §6
machinery above applies to it — there is no `.dylib` to keep replaceable and no
source tarball to mirror. What MPL-2.0 §3.2 asks is narrower and file-scoped:
the library's own files stay MPL, and modifications **to those files** are
published. It does not reach this product's source. Depending on it therefore
costs the same as depending on the LGPL ffmpeg beside it — a named component and
a licence text, nothing structural.

Two things to do when the rewrite actually installs it, and not before:

1. **Name it on the About surface.** `AboutPane.tsx` lists components off the
   manifest and reads each text out of `licences/`, so the entry has to exist in
   both or it is silently absent — the same failure the kvazaar `|| true` caused.
2. **Vendor the library unmodified.** Patching it in `node_modules` is what
   triggers the publication duty; a wrapper module beside it does not.

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
   three obligations to be met.

   **Re-cut it whenever a pin *or the script itself* changes.** The first
   version of this rule said "whenever a pin changes", which is too narrow and
   was wrong within a day: §6 asks for the scripts used to control compilation,
   so a script that has changed materially makes the offer stale even when
   every version it names is identical. Measured 2026-09-11 — the published
   asset was the 381-line pre-universal script against 647 lines in the tree,
   different sha256, same four tarballs. Re-uploading `build-media-stack.sh` to
   the existing tag is enough when no pin moved; a bumped pin needs a new tag,
   because the offer names versions and an old tag would offer source we no
   longer ship.

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

Measured on macOS, universal: **`media-stack/ffmpeg` is 48 MB** — `ffmpeg`,
`ffprobe`, nine `.dylib`s, `licences/` and `manifest.json`. It was 22 MB while
it was arm64 only; two slices of eleven Mach-O files is where the rest went,
and it buys an Intel Mac an ffmpeg that runs. `media-stack/mpv` is empty, for
the reason in Status above.

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
