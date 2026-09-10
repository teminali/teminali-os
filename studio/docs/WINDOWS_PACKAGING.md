# Windows packaging — why no Windows build has ever shipped

Handover, 2026-09-07. Written for whoever picks this up next (Antigravity).
Everything below is measured from CI logs, not inferred.

## The symptom

The Windows job packages forever and is killed. It has never once produced an
asset. macOS and Linux build the identical payload in minutes.

| release | Windows job | outcome |
| --- | --- | --- |
| v0.0.2 | 2h31m | cancelled |
| v0.0.3 | 19m19s | cancelled (whole run cancelled) |
| v0.0.5 | 1h02m | **killed by the 60-minute cap** |

`gh release view v0.0.2 --repo teminali/releases` and the same for v0.0.3 and
v0.0.5: no `.exe` on any of them. macOS (arm64 + x64) and Linux are published.

## Where it stops, exactly

Run `34113974769`, job `101716968926` (v0.0.5), the last two lines of
`Package and publish`:

```
11:00:01.4599993Z   • signing with signtool.exe  path=release\win-unpacked\resources\elevate.exe
11:58:13.0851664Z ##[error]The operation was canceled.
```

58 minutes, no output. v0.0.2 stopped on the same line.

## What has been ruled out — do not re-try these

1. **7z ultra compression.** The workflow's own comment blamed `-mx=9`, and
   `ELECTRON_BUILDER_COMPRESSION_LEVEL=1` was added for it. v0.0.5 is the first
   build that carried it. It changed nothing — same line, same silence, killed
   at the cap. The hypothesis is tested and false.

2. **signtool hanging.** The log's last line makes this look likely. It is not.
   `codeSign/windowsCodeSign.js:13` prints `signing with signtool.exe`
   *unconditionally, before any certificate check*. Then
   `codeSign/windowsSignToolManager.js:155`: with no certificate and no sign
   hook it logs *"no signing info identified, signing is skipped"* at **debug**
   level and returns immediately — no signtool process is ever spawned. We
   never saw that line because DEBUG was off. The hang is the step *after*
   signing: the app archive.

3. **`nsis.differentialPackage: false`.** Run `34116921025`. Windows ran to its
   60-minute cap. Not sufficient alone.

4. **`nsis.useZip: true`** (Deflate instead of LZMA, only reachable with
   `differentialPackage: false` — `NsisTarget.js:78`). Run `34119836026`.
   Still packing at 24 minutes against macOS's 4m02s for identical work.
   Not sufficient.

Both (3) and (4) are still committed on `master`. They are cheap and probably
right in direction; they are simply not enough on their own.

## The cause, proven

Run `34122224708`, branch `win-trim-clean` — the sidecar dropped from the
Windows package and **nothing else changed**:

```
Windows ✓ 2m59s   Teminali-OS-Setup-0.0.5-Windows-x64.exe, 157 MB
```

Same runner, same workflow, same commit base. Against 1h00m15s for
`differentialPackage: false` alone (run `34116921025`) and a run to the cap for
`useZip` on top of it (run `34119836026`), both on the full payload.

So it is the payload, not the codec, not the level, not the signing, and not
the differential machinery. The wizard-download design below is therefore the
whole fix, not a workaround for something still undiagnosed.

## What the payload actually is

`studio/voice-runtime/node_modules` is **1.7 GB** raw, of which **1.0 GB** is
`@huggingface/transformers/.cache` that the filters already exclude. What
actually ships is **573 MB in 1,027 files**, before the per-platform
onnxruntime pruning.

Windows packaged in **2m05s** at v1.2.7, when the payload was ~200 MB. It has
never finished since the sidecar was added. That correlation is the strongest
evidence we have.

## The stop-gap, currently on branch `win-trim-clean`

Windows drops `voice-runtime/node_modules` from `extraResources` entirely. One
commit off `master`, two files: `studio/electron-builder.yml` and
`studio/tests/packaging-resources.test.mjs`.

The app still runs: `server/speech-local.js:105` imports the lexicon with
`.catch(() => null)` and warns that transcripts will not be
vocabulary-repaired, and an absent local recogniser is already a supported
state (`whisper.cpp is not installed`). Local speech degrades; nothing crashes.

`tests/packaging-resources.test.mjs` was updated: the sidecar-pruning assertion
was `blocks.length === 3` and is now `>= 2` plus an explicit assertion that
`win` has no block. **Restore it to 3 when the real fix lands.**

## The real fix — download the sidecar in the installer wizard

Not yet built. This is the task.

**The trap:** electron-builder's `nsis-web` target does *not* solve this.
`WebInstallerTarget extends NsisTarget`, so the same package archive is still
built at build time; nsis-web only moves the *download* to install time. It
would hang in exactly the same step.

The download has to replace something we stop packing:

1. Keep the sidecar out of the Windows package (the stop-gap above).
2. Build and upload `voice-runtime-win32-x64.zip` as its own release asset from
   the same workflow.
3. Fetch it from the wizard. `studio/build/installer.nsh` already exists and
   already defines `customWelcomePage` / `customFinishPage`, so there is a hook
   point; add `customInstall`. The `inetc` plugin ships inside electron-builder's
   own NSIS distribution — see
   `app-builder-lib/templates/nsis/include/webPackage.nsh:43` for a working
   `inetc::get` with resume, a `/NOPROXY` retry and cancel handling. Mirror it
   rather than inventing one.

**What it has to handle:**

- Someone cancels, or installs offline. Local speech must degrade, not break —
  it already does, so the installer must not treat a failed download as fatal.
- The updater replaces the whole installer (`server/updates.js:10`), so every
  update re-downloads the sidecar unless it is versioned and cached outside the
  install directory.
- Uninstall has to remove it.

## Instrumentation already in place

`DEBUG: electron-builder` is set on the Windows runner only, in
`.github/workflows/release.yml`. The last two failures were diagnosed from
silence and diagnosed wrong; this prints the 7za command line, the signtool
invocation and makensis's own output. **Read that before forming a new theory.**

## How to test without cutting a tag

`gh workflow run release.yml --ref <branch> -f dry_run=true`. A dry run builds
all three platforms, publishes nothing, and keeps the installers as run
artifacts (`gh run download <run-id>`). Verify runs first and takes ~2 minutes;
a Windows job that is still in `Package and publish` ten minutes later has
failed, whatever it says.

## Second missing dependency: ffmpeg is not bundled anywhere

Found on the first real Windows install, 2026-09-07: the export dialog refuses
with *"ffmpeg was not found. winget install Gyan.FFmpeg"*.

This is **not** caused by the sidecar trim, and it is not Windows-specific.
`electron-builder.yml` has no ffmpeg entry for any platform — the app searches
known install locations (`electron/mediaAccess.cjs#fixedFfmpegDirs`, which
already covers Chocolatey, Scoop and both winget directories) and tells the
operator to install it. It works on the developers' Macs because Homebrew put
it there years ago. **Every fresh install, on every OS, cannot export or record
until the user installs ffmpeg by hand.**

The operator's workaround is one line in PowerShell — `winget install
Gyan.FFmpeg`, then restart the app so the new PATH is picked up — but a
customer should never see this.

### The rule this broke

**A customer must never be shown a shell command.** The dialog printed
`winget install Gyan.FFmpeg` in red and stopped there, which is a developer's
note left in a product. Whatever the app needs, it either ships with it, or
fetches it with a progress bar and a button — a missing dependency is the
application's problem to solve, not a task to delegate to the person who bought
it. The same rule applies to the sidecar work above: if the wizard's download
fails, the recovery is a button that retries, never an instruction.

**The licence is picked: LGPL, built here.** The Gyan build named in that error
is **GPL**, and shipping GPL binaries inside a product that is sold carries
obligations — an offer of source, and care about coupling. The operator settled
this on 2026-09-10 alongside the same question for mpv: both are built LGPL
rather than taken prebuilt. The recipe, the obligations and the one real cost
are in [`MEDIA_LICENSING.md`](MEDIA_LICENSING.md).

That cost, before anyone drops a binary in: an LGPL FFmpeg has no `libx264` and
no `libx265`, and those are the software encode fallback in five places
(`server/media-probe.js:256` and four others). Hardware encoders cover most
machines, not all, and not Linux. **The turn that bundles ffmpeg replaces those
five call sites in the same turn** — otherwise the bundle breaks export on
exactly the clean machines it was meant to fix.

The fix is the same shape as the sidecar one, and cheaper: a Windows ffmpeg
static build is roughly 80-120 MB against the sidecar's 573 MB, so bundling it
outright would not reintroduce the packaging failure this document is about.
Bundle it, or fetch it in the same wizard step. Do not ship another installer
without deciding which.

## Open, and not started

- Nothing is signed, on any platform. SmartScreen shows "Windows protected your
  PC" on every build we produce. `CSC_LINK` and the three `APPLE_*` secrets are
  wired and absent.
