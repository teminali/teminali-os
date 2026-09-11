#!/usr/bin/env bash
#
# Build the LGPL media stack this app bundles: ffmpeg and mpv, made here.
#
# `docs/MEDIA_LICENSING.md` is the governing spec and the reasoning; this is the
# recipe it describes. The two rules that matter, because breaking either one
# relicenses a closed, sold product as GPL and nothing warns you:
#
#   • ffmpeg: no --enable-gpl, and no --enable-nonfree. The second is not a
#     licence at all and cannot be distributed under any terms.
#   • mpv: -Dgpl=false, AND built against the LGPL ffmpeg above. An mpv built
#     in LGPL mode against a GPL ffmpeg is still a GPL binary.
#
# Output: media-stack/ffmpeg/ and media-stack/mpv/, which electron-builder
# copies to <Resources>/ffmpeg and <Resources>/mpv. Both binaries are made
# relocatable — they load the .dylib/.so beside them, not one in /opt — which
# is also what LGPL-2.1 §6 asks for: a library the user can replace.
#
# On macOS the whole closure is built once PER ARCHITECTURE and `lipo -create`d
# into one universal bundle. That is not a nicety. The release job builds
# `--mac --arm64 --x64` from a single arm64 runner and copies the same
# media-stack/ffmpeg into both app bundles, and `findFfmpeg` prefers the bundled
# copy over PATH — so a thin arm64 binary arrives on an Intel Mac as an ffmpeg
# that cannot exec, while the working system one never gets a turn. That is why
# `verify_bundle` asserts every slice: a fat binary missing one fails the build
# exactly like a thin one, because both fail identically on the machine you do
# not have.
#
# Run end to end on macOS (arm64) 2026-09-11. Three things only a real run could
# show, all fixed here and all worth knowing before editing this file:
#
#   • `relocate` was a no-op. It rewrote the path each library was COPIED to;
#     Mach-O records the path it was LINKED against. Every staged binary still
#     pointed into the build tree and died with "Library not loaded" anywhere
#     else. `verify_bundle` below now makes that failure fatal at build time.
#   • An autodetecting build absorbs the build machine. mpv linked Homebrew's
#     librubberband — GPL-2.0-or-later — because its meson option defaults to
#     `auto`, and `-Dgpl=false` does not gate it: that flag governs mpv's own
#     GPL code, not what it links. Every optional dependency is now stated.
#   • The second architecture belongs in CC, not in ARCH and not in CFLAGS.
#     openh264's darwin makefile adds `-arch arm64` for arm64 and nothing at all
#     for x86_64, so `make ARCH=x86_64` compiles native C and assembles foreign
#     asm; and all three build systems here do `CFLAGS +=`, which a
#     command-line `CFLAGS=` replaces rather than extends — taking `-fPIC` with
#     it. `CC="clang -arch <arch>"` is the one channel all three honour.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/media-stack"
WORK="${MEDIA_STACK_WORK:-$HERE/.media-stack-build}"
JOBS="${MEDIA_STACK_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

# Pinned, because "whatever was latest on the day" is not a source offer
# anybody can honour. Bumping one means re-reading the dropped-component set.
# Where the corresponding sources live for as long as a release carrying these
# binaries is out there. LGPL-2.1 §6 wants an offer that outlives the release,
# so this is a real decision rather than a default someone forgets to change.
MEDIA_STACK_SOURCE_OFFER="${MEDIA_STACK_SOURCE_OFFER:-https://github.com/teminali/releases/releases/tag/media-stack-7.1.1}"

FFMPEG_VERSION=7.1.1
MPV_VERSION=0.39.0
OPENH264_VERSION=2.4.1
KVAZAAR_VERSION=2.3.1

log() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  # PLATFORM_FFMPEG_FLAGS re-enables what --disable-autodetect turns off and we
  # actually want: the OS's own codecs, which live in system frameworks and so
  # need no bundling. h264_videotoolbox is the hardware encoder the exporter
  # prefers — losing it silently would push every Mac onto openh264.
  Darwin) PLATFORM=macos
          # --extra-libs=-liconv because --disable-autodetect also skips the
          # probe that would have added it, and libavcodec's subtitle path
          # references iconv unconditionally. macOS keeps libiconv in /usr/lib,
          # so this links against the system copy and needs no bundling.
          PLATFORM_FFMPEG_FLAGS="--enable-videotoolbox --enable-audiotoolbox --enable-avfoundation --enable-coreimage --extra-libs=-liconv" ;;
  # Linux gets software encoders only. vaapi/nvenc would need their loaders
  # present at build time and bundled after; untested here, so not claimed.
  Linux)  PLATFORM=linux; PLATFORM_FFMPEG_FLAGS="" ;;
  *)
    # Windows is not built here yet. It exits 0 rather than failing: a Windows
    # release that packs no media stack is exactly v0.0.6's behaviour, and
    # failing the job would take away the first Windows build this project ever
    # shipped in exchange for a bundle it has never had. The route when it is
    # written is msys2/mingw-w64, native or cross — see docs/MEDIA_LICENSING.md.
    echo "build-media-stack: no Windows recipe yet; shipping without the bundle." >&2
    exit 0
    ;;
esac

# ── Which architectures ────────────────────────────────────────────────────
# macOS ships universal or it ships broken; see the header. The macOS SDK
# carries both slices of every system library, so an arm64 Mac cross-builds
# x86_64 with a compiler flag and no cross toolchain at all.
#
# MEDIA_STACK_ARCHS exists for a fast native iteration (`MEDIA_STACK_ARCHS=arm64`
# halves the build). It is deliberately NOT what CI uses, and manifest.json
# records what was actually built so a thin bundle cannot claim otherwise.
NATIVE_ARCH="$(uname -m)"
case "$PLATFORM" in
  macos) DEFAULT_ARCHS="arm64 x86_64" ;;
  linux) DEFAULT_ARCHS="$NATIVE_ARCH" ;;
esac
ARCHS="${MEDIA_STACK_ARCHS:-$DEFAULT_ARCHS}"
ARCH_COUNT="$(printf '%s\n' $ARCHS | wc -l | tr -d ' ')"
PRIMARY_ARCH="${ARCHS%% *}"
[ "$PLATFORM" = macos ] || [ "$ARCH_COUNT" = 1 ] \
  || die "MEDIA_STACK_ARCHS names $ARCH_COUNT architectures, but only macOS can fuse them (lipo)"

# mpv is built only for a single native architecture, and so does not ship in a
# universal bundle at all. It hard-requires libplacebo and libass — mpv 0.39 has
# no meson switch for either — and this script builds neither, so meson takes
# the build machine's copies, which exist for the native architecture only.
# There is nothing to lipo against, and a universal bundle cannot carry a thin
# binary. Skipping it beats building it for minutes and discarding it: the
# outcome on macOS is the same empty media-stack/mpv either way, which is
# exactly v0.0.6's behaviour. See docs/MEDIA_LICENSING.md.
if [ "$ARCH_COUNT" = 1 ] && [ "$ARCHS" = "$NATIVE_ARCH" ]; then BUILD_MPV=yes; else BUILD_MPV=no; fi

need() { command -v "$1" >/dev/null 2>&1 || die "missing build tool: $1"; }
need curl; need tar; need make; need pkg-config
# meson and ninja build mpv and nothing else, so they are required only when
# mpv is. On the default macOS build that is never — which is the difference
# between a CI runner that needs three extra tools and one that needs nasm.
if [ "$BUILD_MPV" = yes ]; then need meson; need ninja; fi
if [ "$PLATFORM" = macos ]; then need lipo; need otool; need install_name_tool; else need patchelf; fi
# Only x86 needs one. nasm assembles ffmpeg's x86 SIMD and nothing else — the
# arm64 and aarch64 paths go through the C compiler's own assembler for NEON —
# so demanding it unconditionally refuses a build it is no part of. Measured on
# aarch64 Ubuntu 24.04, 2026-09-11: the gate stopped a Linux build that then
# completed without nasm ever being installed.
case " $ARCHS " in
  *" x86_64 "*|*" amd64 "*|*" i386 "*|*" i686 "*)
    command -v nasm >/dev/null 2>&1 || command -v yasm >/dev/null 2>&1 \
      || die "missing build tool: nasm (or yasm) — ffmpeg's x86 assembly needs one" ;;
esac

mkdir -p "$WORK"
# Saved because the ffmpeg closure is built hermetically against its own prefix
# and nothing else, while mpv genuinely needs the machine's pkg-config path to
# find the libplacebo and libass it cannot do without.
HOST_PKG_CONFIG_PATH="${PKG_CONFIG_PATH:-}"

tarball() { # url sha256 → the verified tarball's path
  local url="$1" sha="$2" file="$WORK/$(basename "$1")"
  # The checksums are pinned so a later run builds the same bytes the source
  # offer names — a source offer is only worth something if the sources are the
  # ones we built. The guard below stays: bumping a version without re-pinning
  # stops the build rather than silently shipping something else.
  #
  # ffmpeg is verified against its upstream GPG signature; the other three have
  # no upstream checksum published, so these are measured from the canonical
  # host. openh264 and mpv are GitHub *archive* tarballs, generated per request
  # — GitHub has changed that generator before, so a mismatch on those two means
  # re-verify upstream before assuming the worst.
  case "$sha" in SET_ME*) die "no checksum pinned for $(basename "$url"): fill it in before this ships" ;; esac
  [ -f "$file" ] || curl -fsSL "$url" -o "$file"
  if command -v shasum >/dev/null 2>&1; then
    echo "$sha  $file" | shasum -a 256 -c - >/dev/null \
      || die "checksum mismatch for $(basename "$url") — refusing to build it"
  fi
  printf '%s' "$file"
}

unpack() { # tarball dir arch → a pristine per-architecture source tree
  # Each architecture gets its own extraction instead of a `make clean` between
  # passes. openh264 and ffmpeg both build in-tree, and an object file left over
  # from the other architecture does not announce itself — it fails at link, or
  # it does not fail at all and ships.
  local file="$1" dir="$2" root="$WORK/src-$3"
  mkdir -p "$root"
  [ -d "$root/$dir" ] || tar -xf "$file" -C "$root"
  printf '%s' "$root/$dir"
}

# ── One architecture's closure: openh264, kvazaar, ffmpeg ──────────────────
build_arch() { # arch
  local arch="$1" prefix="$WORK/prefix-$arch" src cross=""
  # The compiler override is a macOS mechanism and is used nowhere else: `-arch`
  # is Apple clang's flag, and it is the macOS SDK that carries both slices.
  # Linux builds its one native architecture with whatever `cc` the machine has,
  # exactly as this script always did — setting CC there would hand gcc a flag
  # it does not have. Arrays, because `CC=clang -arch arm64` has to survive as
  # ONE argument; `${a[@]+"${a[@]}"}` because bash 3.2 — which is what
  # /usr/bin/env bash still finds on macOS — treats an empty `"${a[@]}"` as an
  # unbound variable under `set -u`.
  local -a cc_make=() cc_conf=() cc_ffmpeg=()
  if [ "$PLATFORM" = macos ]; then
    cc_make=(CC="clang -arch $arch" CXX="clang++ -arch $arch")
    cc_conf=(CC="clang -arch $arch")
    cc_ffmpeg=(--cc="clang -arch $arch" --cxx="clang++ -arch $arch")
    # Cross-compiling is likewise a macOS-only claim here: --target-os=darwin
    # would be a lie anywhere else, and Linux only ever builds its native one.
    [ "$arch" = "$NATIVE_ARCH" ] \
      || cross="--enable-cross-compile --arch=$arch --target-os=darwin"
  fi
  mkdir -p "$prefix"
  # Hermetic on purpose: only what this script built. With the machine's
  # pkg-config path still on the end, a failed openh264 build would silently
  # resolve to Homebrew's — the wrong architecture, and a version no source
  # offer names.
  export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"

  # ── The LGPL-clean encoders that replace x264 and x265 ────────────────────
  # Named in docs/MEDIA_LICENSING.md: openh264 is Cisco's, BSD-2; kvazaar is
  # LGPL-2.1. Without them an LGPL ffmpeg has NO software video encoder, and a
  # machine with no hardware encoder cannot export at all.
  log "openh264 $OPENH264_VERSION ($arch)"
  src="$(unpack "$OPENH264_TARBALL" "openh264-$OPENH264_VERSION" "$arch")"
  # ARCH still has to be right — it picks the asm and its output format — but it
  # is CC that decides what the C compiles to. See the header.
  make -C "$src" -j"$JOBS" ARCH="$arch" ${cc_make[@]+"${cc_make[@]}"} PREFIX="$prefix" install-shared

  log "kvazaar $KVAZAAR_VERSION ($arch)"
  src="$(unpack "$KVAZAAR_TARBALL" "kvazaar-$KVAZAAR_VERSION" "$arch")"
  ( cd "$src" \
    && ./configure --prefix="$prefix" --enable-shared --disable-static \
         ${cross:+--host="$arch-apple-darwin"} ${cc_conf[@]+"${cc_conf[@]}"} \
    && make -j"$JOBS" && make install )

  # ── ffmpeg ───────────────────────────────────────────────────────────────
  log "ffmpeg $FFMPEG_VERSION (LGPL, $arch)"
  src="$(unpack "$FFMPEG_TARBALL" "ffmpeg-$FFMPEG_VERSION" "$arch")"
  (
    cd "$src"
    # --enable-shared --disable-static is not a size preference. LGPL-2.1 §6 is
    # satisfied by a library the user can REPLACE with their own build, and a
    # static link into a closed binary cannot be replaced.
    # --disable-autodetect is the whole hermeticity argument in one flag. Without
    # it configure enables whatever the build machine happens to have: the first
    # run picked up Homebrew's SDL2, libxcb and libX11 — none of them useful on a
    # Mac, none of them bundled, all of them absolute paths into /opt/homebrew.
    # With it, this bundle contains exactly what is named here and nothing else.
    ./configure \
      --prefix="$prefix" \
      ${cc_ffmpeg[@]+"${cc_ffmpeg[@]}"} $cross \
      --enable-shared --disable-static \
      --enable-pic \
      --disable-debug --disable-doc \
      --disable-autodetect \
      --enable-libopenh264 \
      --enable-libkvazaar \
      --enable-zlib --enable-bzlib --enable-iconv \
      $PLATFORM_FFMPEG_FLAGS \
      --disable-programs --enable-ffmpeg --enable-ffprobe \
      ${EXTRA_FFMPEG_FLAGS:-} 2>&1 | tee "$WORK/ffmpeg-configure-$arch.log"
    grep -q -- "--enable-gpl" config.h 2>/dev/null \
      && die "this ffmpeg configured itself GPL; the bundle cannot ship"
    make -j"$JOBS" && make install
  )
}

OPENH264_TARBALL="$(tarball "https://github.com/cisco/openh264/archive/refs/tags/v$OPENH264_VERSION.tar.gz" \
  "8ffbe944e74043d0d3fb53d4a2a14c94de71f58dbea6a06d0dc92369542958ea")"
KVAZAAR_TARBALL="$(tarball "https://github.com/ultravideo/kvazaar/releases/download/v$KVAZAAR_VERSION/kvazaar-$KVAZAAR_VERSION.tar.xz" \
  "ca30575026d2f1a1201af4b94697bb0fcd05913388008631dc3332bae94122bd")"
FFMPEG_TARBALL="$(tarball "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
  "733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1")"
MPV_TARBALL="$(tarball "https://github.com/mpv-player/mpv/archive/refs/tags/v$MPV_VERSION.tar.gz" \
  "2ca92437affb62c2b559b4419ea4785c70d023590500e8a52e95ea3ab4554683")"

for arch in $ARCHS; do build_arch "$arch"; done

# ── mpv ────────────────────────────────────────────────────────────────────
if [ "$BUILD_MPV" = yes ]; then
  log "mpv $MPV_VERSION (LGPL, against the ffmpeg above)"
  MPV_SRC="$(unpack "$MPV_TARBALL" "mpv-$MPV_VERSION" "$PRIMARY_ARCH")"
  (
    cd "$MPV_SRC"
    # The one build here that is allowed to see the machine: libplacebo and
    # libass are not ours and have to come from somewhere.
    export PKG_CONFIG_PATH="$WORK/prefix-$PRIMARY_ARCH/lib/pkgconfig${HOST_PKG_CONFIG_PATH:+:$HOST_PKG_CONFIG_PATH}"
    # mpv's build RUNS the mpv it just built — TOOLS/gen-mpv-desktop.py asks it
    # for its protocol list — and on ELF that binary resolves libopenh264.so.7
    # through the runtime linker, not by the absolute path Mach-O records. The
    # prefix is on no system path, so without this the build dies at the
    # desktop-file step with "cannot open shared object file", having compiled
    # every object successfully first. Measured on aarch64 Ubuntu 24.04,
    # 2026-09-11; macOS never needed it and still does not.
    [ "$PLATFORM" = macos ] \
      || export LD_LIBRARY_PATH="$WORK/prefix-$PRIMARY_ARCH/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    # -Dlibmpv=true builds the shared library as well as the player: Windows and
    # Linux spawn the executable, macOS links the library, and both come out of
    # one build.
    # Every one of these defaults to `auto`, which means "link it if the build
    # machine has it". rubberband is the one that matters — it is GPL-2.0-or-later
    # and it linked itself into the first build — but each of the others is a
    # library this script does not build, so each would be an absolute path into
    # /opt/homebrew in the shipped binary.
    meson setup build \
      -Dgpl=false -Dlibmpv=true -Dcplayer=true \
      -Drubberband=disabled \
      -Dlibbluray=disabled -Duchardet=disabled -Dzimg=disabled \
      -Djavascript=disabled -Dlua=disabled -Dlcms2=disabled \
      -Dlibarchive=disabled -Dvapoursynth=disabled -Dsdl2=disabled \
      -Dvulkan=disabled -Dshaderc=disabled -Dspirv-cross=disabled \
      -Djpeg=disabled -Ddvbin=disabled -Dcplugins=disabled \
      --prefix="$WORK/prefix-$PRIMARY_ARCH" --buildtype=release 2>&1 | tee "$WORK/mpv-meson.log"
    # meson prints its resolved options one per line; that is the line to read.
    # The first version grepped "gpl.*true" across the whole log and matched the
    # Build Options line — "-Dgpl=false … -Dlibmpv=true" — so it warned on every
    # correct build, which is how a warning stops being read.
    grep -qE '^[[:space:]]*gpl[[:space:]]*:[[:space:]]*true' build/meson-logs/meson-log.txt \
      && die "meson resolved gpl=true; a GPL mpv must not ship"
    ninja -C build -j"$JOBS" && ninja -C build install
  )
else
  echo "note: mpv is not built for a universal bundle (see the comment above);" >&2
  echo "      media-stack/mpv stays empty, as it does in v0.0.6 and v0.0.7." >&2
fi

# ── Stage the real closure, relocate it, fuse it, and prove it ─────────────
# Without this the shipped ffmpeg looks for its dylibs in the build prefix,
# which exists only on the build machine. It starts on the runner and dies on a
# customer's Mac with "Library not loaded" — a failure that no test on the build
# machine can see, and one the first version of this section did not prevent
# despite saying so. `verify_bundle` is the part that cannot quietly do nothing.

# A file this script relocates and checks. This used to test for Mach-O only,
# which is false for every ELF file — so on Linux the dependency walk, the
# relocation and the whole of staging skipped every binary they were given and
# reported success. Measured on aarch64 Ubuntu 24.04, 2026-09-11: the staged
# `media-stack/ffmpeg` held the two executables, no libraries at all, no rpath,
# seven unresolved sonames, and did not start. Platform goes in the test.
is_binary() {
  case "$PLATFORM" in
    macos) file -b "$1" 2>/dev/null | grep -q "Mach-O" ;;
    *)     file -b "$1" 2>/dev/null | grep -q "^ELF" ;;
  esac
}

# What a Mach-O file records that it will load at run time. The first entry for
# a dylib is its own install name, which is why relocation sets that too.
# Read one slice at a time: a fat binary can be clean in the architecture you
# are standing on and point into /opt in the one you are not.
macho_deps() { # file [arch]
  if [ "${2:-}" = "" ]; then otool -L "$1" 2>/dev/null | tail -n +2 | awk '{print $1}'
  else otool -arch "$2" -L "$1" 2>/dev/null | tail -n +2 | awk '{print $1}'; fi
}

# ELF records a SONAME, not a path — the runtime linker finds it wherever it
# can. That difference is the whole reason Linux needs its own staging rules
# rather than the macOS ones with `patchelf` swapped in for `install_name_tool`.
elf_needed() { patchelf --print-needed "$1" 2>/dev/null; }

# Libraries a glibc Linux is guaranteed to have, so bundling them would be
# wrong rather than merely redundant — a private libc is how you get a binary
# that runs on the build machine and nowhere else.
#
# Everything NOT on this list and not inside the bundle means we are relying on
# a library the user may not have and whose licence we cannot state. That is
# exactly mpv's libplacebo and libass, and it is why mpv does not ship: the
# same verdict macOS reaches, by a different route.
LINUX_BASE_LIBS="libc.so.6 libm.so.6 libpthread.so.0 libdl.so.2 librt.so.1
libgcc_s.so.1 libstdc++.so.6 libz.so.1 libbz2.so.1.0 libatomic.so.1
ld-linux-aarch64.so.1 ld-linux-x86-64.so.2 ld-linux-armhf.so.3 linux-vdso.so.1"

# A path the customer's Mac will resolve without our help, or one already made
# relative to the bundle. Anything else is a path off this machine.
is_self_contained() {
  case "$1" in
    /usr/lib/*|/System/*|@rpath/*|@loader_path/*|@executable_path/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The ELF equivalent: a soname that is either beside the binary or part of the
# base system. `$ORIGIN` makes the first one resolve on the user's machine.
is_base_or_bundled() { # soname destdir
  [ -e "$2/$1" ] && return 0
  case " $(echo $LINUX_BASE_LIBS) " in *" $1 "*) return 0 ;; esac
  return 1
}

stage_closure() { # prefix destdir binary...
  # Only the libraries the binaries actually load, followed transitively. The
  # first version copied all of the prefix's lib/ into both directories, which
  # put libmpv — and the claim to everything libmpv links — inside the ffmpeg
  # bundle. Each dependency is copied under the name it is recorded by, so a
  # symlinked soname becomes one real file rather than three copies.
  local prefix="$1" dest="$2"; shift 2
  local src f dep base added=1
  for src in "$@"; do cp -L "$src" "$dest/$(basename "$src")"; done
  while [ "$added" = 1 ]; do
    added=0
    for f in "$dest"/*; do
      if [ ! -f "$f" ] || ! is_binary "$f"; then continue; fi
      # The rule is identical on both platforms — copy only what this script
      # built — but what a binary *records* is not, so resolving a dependency
      # to a file differs. Mach-O names an absolute path and the walk follows
      # it; ELF names a soname and the walk has to look for it in the prefix.
      for dep in $(if [ "$PLATFORM" = macos ]; then macho_deps "$f"; else elf_needed "$f"; fi); do
        if [ "$PLATFORM" = macos ]; then
          if is_self_contained "$dep"; then continue; fi
          base="$(basename "$dep")"
        else
          base="$dep"
          dep="$prefix/lib/$base"
        fi
        if [ -e "$dest/$base" ] || [ ! -e "$dep" ]; then continue; fi
        # Only libraries this script built, from a pinned and checksummed
        # source. Left to itself this walk is happy to pull /opt/homebrew into
        # the bundle — it did, the first time the closure actually worked, and
        # produced an mpv carrying fourteen libraries nobody pinned. A source
        # offer has to name a version, and "whatever brew had that morning" is
        # not one. Anything outside the prefix is left dangling on purpose, and
        # verify_bundle then refuses to stage whatever depends on it.
        case "$dep" in "$prefix"/*) ;; *) continue ;; esac
        cp -L "$dep" "$dest/$base"
        added=1
      done
    done
  done
}

relocate() { # destdir
  local dest="$1" f dep base
  for f in "$dest"/*; do
    if [ ! -f "$f" ] || ! is_binary "$f"; then continue; fi
    if [ "$PLATFORM" = macos ]; then
      # -id first: a library has to announce itself by basename before any
      # sibling pointing at it can be rewritten to @rpath.
      case "$f" in *.dylib) install_name_tool -id "@rpath/$(basename "$f")" "$f" 2>/dev/null || true ;; esac
      install_name_tool -add_rpath "@loader_path" "$f" 2>/dev/null || true
      # -change takes the path RECORDED IN THE FILE, not the path we copied it
      # to. Getting that backwards is what made the first version a no-op.
      for dep in $(macho_deps "$f"); do
        if is_self_contained "$dep"; then continue; fi
        base="$(basename "$dep")"
        [ -e "$dest/$base" ] || continue
        install_name_tool -change "$dep" "@rpath/$base" "$f" 2>/dev/null || true
      done
    else
      # $ORIGIN is the directory the binary is in, resolved by the runtime
      # linker — the ELF answer to @loader_path. A soname is not rewritten the
      # way a Mach-O path is: the name stays, only the search path changes.
      patchelf --set-rpath '$ORIGIN' "$f" 2>/dev/null || true
    fi
  done
}

fuse() { # destdir stagedir... — one universal bundle out of the per-arch ones
  local dest="$1"; shift
  local first="$1" f base other inputs
  # The same closure on every side, or the bundle is a lie: a library present
  # for one architecture and not the other means the two ffmpegs configured
  # themselves differently, and fusing only what the first one has would ship
  # the second one's binary without something it loads.
  for other in "$@"; do
    diff <(cd "$first" && ls -1) <(cd "$other" && ls -1) >/dev/null \
      || die "the $(basename "$(dirname "$first")") and $(basename "$(dirname "$other")") closures hold different files; refusing to fuse them"
  done
  for f in "$first"/*; do
    base="$(basename "$f")"
    if [ "$#" -gt 1 ] && is_binary "$f"; then
      inputs=""
      for other in "$@"; do inputs="$inputs $other/$base"; done
      lipo -create $inputs -output "$dest/$base"
    else
      cp "$f" "$dest/$base"
    fi
  done
}

verify_bundle() { # destdir — 0 if it carries every architecture and nothing in
                  # it points off this machine, in any slice
  local dest="$1" f dep arch have bad=0
  # This used to `return 0` on anything but macOS — a check that passed by
  # declining to look, which is the one failure mode the whole function exists
  # to prevent. It let Linux stage an ffmpeg with seven unresolved sonames and
  # call it verified, and let the manifest claim an mpv that could not start.
  if [ "$PLATFORM" != macos ]; then
    for f in "$dest"/*; do
      if [ ! -f "$f" ] || ! is_binary "$f"; then continue; fi
      # Read the recorded SONAMEs rather than asking `ldd` what resolves today.
      # `ldd` answers for THIS machine: on a build box that happens to carry
      # libplacebo, an mpv depending on it resolves cleanly and ships broken to
      # everyone else. That is the same "absorbs the build machine" trap the
      # ffmpeg configure flags exist to close, one layer down.
      for dep in $(elf_needed "$f"); do
        if is_base_or_bundled "$dep" "$dest"; then continue; fi
        printf '    %s → %s (not bundled, not base system)\n' "$(basename "$f")" "$dep" >&2
        bad=1
      done
      case "$(patchelf --print-rpath "$f" 2>/dev/null)" in
        *'$ORIGIN'*) ;;
        *) printf '    %s: no $ORIGIN rpath — it would not find its siblings\n' "$(basename "$f")" >&2; bad=1 ;;
      esac
    done
    return "$bad"
  fi
  for f in "$dest"/*; do
    if [ ! -f "$f" ] || ! is_binary "$f"; then continue; fi
    have="$(lipo -archs "$f" 2>/dev/null || true)"
    for arch in $ARCHS; do
      case " $have " in
        *" $arch "*) ;;
        *) printf '    %s: no %s slice (has: %s)\n' "$(basename "$f")" "$arch" "${have:-none}" >&2; bad=1; continue ;;
      esac
      for dep in $(macho_deps "$f" "$arch"); do
        if is_self_contained "$dep"; then continue; fi
        printf '    %s (%s) → %s\n' "$(basename "$f")" "$arch" "$dep" >&2
        bad=1
      done
    done
  done
  return "$bad"
}

reset_stage_dir() { # dir — empty it, keeping the README that holds it in git
  # This used to be `rm -rf` followed by `git checkout -- …/README.md`, which
  # restores nothing: media-stack/ is untracked until its first commit, and an
  # untracked file this script deletes is simply gone. It took both READMEs
  # with it on the first run, and with them the directories themselves — which
  # exist only because git will not track an empty one, and which an
  # extraResources `from:` needs in order to resolve.
  local dir="$1"
  mkdir -p "$dir"
  find "$dir" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
}

log "staging ($ARCHS)"
reset_stage_dir "$OUT/ffmpeg"
reset_stage_dir "$OUT/mpv"

STAGES=""
for arch in $ARCHS; do
  STAGE="$WORK/stage-$arch/ffmpeg"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  stage_closure "$WORK/prefix-$arch" "$STAGE" "$WORK/prefix-$arch/bin/ffmpeg" "$WORK/prefix-$arch/bin/ffprobe"
  # Relocated per architecture, before fusing: install_name_tool edits every
  # slice of a fat file, but the two closures are thin here and each one's
  # recorded paths point into its own prefix.
  relocate "$STAGE"
  STAGES="$STAGES $STAGE"
done
fuse "$OUT/ffmpeg" $STAGES
if ! verify_bundle "$OUT/ffmpeg"; then
  # Cleared before dying. The release workflow runs this script with
  # continue-on-error, so a directory left populated by a failed run is a
  # broken ffmpeg inside a shipped installer — worse than no bundle at all.
  reset_stage_dir "$OUT/ffmpeg"
  die "the staged ffmpeg is not what it must be (above); it would not start on a customer's Mac"
fi

# The headers are what verify_bundle reads. This is the only step that finds out
# whether the loader agrees: a code signature invalidated by lipo, or an rpath
# that resolves to nothing, both pass a header check and both die right here.
# Only slices this machine can actually execute are run — natively, or through
# Rosetta when it is installed, which is a real test of the cross-built half.
if [ "$PLATFORM" = macos ]; then
  for arch in $ARCHS; do
    if [ "$arch" = "$NATIVE_ARCH" ]; then
      env -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH "$OUT/ffmpeg/ffmpeg" -version >/dev/null \
        || { reset_stage_dir "$OUT/ffmpeg"; die "the staged ffmpeg does not run on the machine that built it"; }
      echo "    ran: $arch (native)"
    elif arch -"$arch" /usr/bin/true >/dev/null 2>&1; then
      env -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH arch -"$arch" "$OUT/ffmpeg/ffmpeg" -version >/dev/null \
        || { reset_stage_dir "$OUT/ffmpeg"; die "the staged ffmpeg's $arch slice does not run under Rosetta"; }
      echo "    ran: $arch (rosetta)"
    else
      echo "    not run: $arch — this machine cannot execute it; headers checked only"
    fi
  done
fi

# mpv is staged only if it comes out clean, and on a universal build it is not
# built at all — see the comment where BUILD_MPV is decided. Shipping no mpv is
# exactly v0.0.6's behaviour; shipping one that cannot start, or one carrying a
# library we cannot honour, is not. See docs/MEDIA_LICENSING.md.
MPV_STAGED=no
if [ "$BUILD_MPV" = yes ] && [ -x "$WORK/prefix-$PRIMARY_ARCH/bin/mpv" ]; then
  stage_closure "$WORK/prefix-$PRIMARY_ARCH" "$OUT/mpv" "$WORK/prefix-$PRIMARY_ARCH/bin/mpv"
  relocate "$OUT/mpv"
  if verify_bundle "$OUT/mpv"; then
    MPV_STAGED=yes
  else
    echo "warning: mpv links libraries this script does not build (above); leaving media-stack/mpv empty." >&2
    reset_stage_dir "$OUT/mpv"
  fi
fi

# ── What LGPL-2.1 §6 asks us to ship beside the binaries ───────────────────
# Each copy is checked. The first version ended every line with `|| true` and
# named kvazaar's licence COPYING, which that tarball does not have — so the
# bundle shipped no kvazaar licence and said nothing. A missing licence text is
# the compliance failure this whole file exists to avoid; it cannot be silent.
SRC="$WORK/src-$PRIMARY_ARCH"
licence() { # src dest
  cp "$1" "$2" || die "missing licence text: $1 — LGPL-2.1 §6 needs it beside the binary"
}
mkdir -p "$OUT/ffmpeg/licences"
licence "$SRC/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$OUT/ffmpeg/licences/ffmpeg-COPYING.LGPLv2.1"
licence "$SRC/openh264-$OPENH264_VERSION/LICENSE"      "$OUT/ffmpeg/licences/openh264-LICENSE"
licence "$SRC/kvazaar-$KVAZAAR_VERSION/LICENSE"        "$OUT/ffmpeg/licences/kvazaar-LICENSE"
if [ "$MPV_STAGED" = yes ]; then
  mkdir -p "$OUT/mpv/licences"
  licence "$SRC/mpv-$MPV_VERSION/LICENSE.LGPL" "$OUT/mpv/licences/mpv-LICENSE.LGPL"
fi

# The manifest the About surface reads: what shipped, at which version, under
# which licence, and where the corresponding source is. Written by the build so
# it cannot drift from the binaries it describes — `archs` included, because a
# bundle built with MEDIA_STACK_ARCHS overridden must not be able to pass itself
# off as the universal one.
MPV_COMPONENT=""
if [ "$MPV_STAGED" = yes ]; then
  MPV_COMPONENT='
    { "name": "mpv",       "version": "'"$MPV_VERSION"'",      "licence": "LGPL-2.1-or-later" },'
fi
ARCHS_JSON="$(printf '"%s", ' $ARCHS)"; ARCHS_JSON="[ ${ARCHS_JSON%, } ]"
cat > "$OUT/manifest.json" <<JSON
{
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platform": "$PLATFORM",
  "archs": $ARCHS_JSON,
  "components": [
    { "name": "FFmpeg",    "version": "$FFMPEG_VERSION",   "licence": "LGPL-2.1-or-later" },$MPV_COMPONENT
    { "name": "openh264",  "version": "$OPENH264_VERSION", "licence": "BSD-2-Clause" },
    { "name": "kvazaar",   "version": "$KVAZAAR_VERSION",  "licence": "LGPL-2.1-or-later" }
  ],
  "sourceOffer": "$MEDIA_STACK_SOURCE_OFFER",
  "buildScript": "studio/scripts/build-media-stack.sh"
}
JSON

# Beside the binaries as well as at the top level: electron-builder copies the
# two staged directories to <Resources>/ffmpeg and <Resources>/mpv and nothing
# else, so a manifest that stays up here is one the About surface cannot read.
# Copying it in needs no new extraResources entry, and so cannot break a build
# made without this script — the property those entries were shaped to keep.
cp "$OUT/manifest.json" "$OUT/ffmpeg/manifest.json"
[ "$MPV_STAGED" = yes ] && cp "$OUT/manifest.json" "$OUT/mpv/manifest.json"

if [ -z "$MEDIA_STACK_SOURCE_OFFER" ]; then
  echo "warning: MEDIA_STACK_SOURCE_OFFER is empty — manifest.json ships no source" >&2
  echo "         offer, which LGPL-2.1 §6 requires. Never release from such a build." >&2
fi

log "done"
lipo -archs "$OUT/ffmpeg/ffmpeg" 2>/dev/null | sed 's/^/    ffmpeg: /' || true
du -sh "$OUT/ffmpeg" "$OUT/mpv" 2>/dev/null || true
echo
echo "Read the dropped-component set off $WORK/ffmpeg-configure-$PRIMARY_ARCH.log and"
echo "record it in docs/MEDIA_LICENSING.md — the spec asks for the measured list."
