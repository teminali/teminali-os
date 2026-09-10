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
# Run end to end on macOS (arm64) 2026-09-11. Two things only a real run could
# show, both fixed here and both worth knowing before editing this file:
#
#   • `relocate` was a no-op. It rewrote the path each library was COPIED to;
#     Mach-O records the path it was LINKED against. Every staged binary still
#     pointed into the build tree and died with "Library not loaded" anywhere
#     else. `verify_bundle` below now makes that failure fatal at build time.
#   • An autodetecting build absorbs the build machine. mpv linked Homebrew's
#     librubberband — GPL-2.0-or-later — because its meson option defaults to
#     `auto`, and `-Dgpl=false` does not gate it: that flag governs mpv's own
#     GPL code, not what it links. Every optional dependency is now stated.
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
  Darwin) PLATFORM=macos; LIBEXT=dylib
          # --extra-libs=-liconv because --disable-autodetect also skips the
          # probe that would have added it, and libavcodec's subtitle path
          # references iconv unconditionally. macOS keeps libiconv in /usr/lib,
          # so this links against the system copy and needs no bundling.
          PLATFORM_FFMPEG_FLAGS="--enable-videotoolbox --enable-audiotoolbox --enable-avfoundation --enable-coreimage --extra-libs=-liconv" ;;
  # Linux gets software encoders only. vaapi/nvenc would need their loaders
  # present at build time and bundled after; untested here, so not claimed.
  Linux)  PLATFORM=linux; LIBEXT=so; PLATFORM_FFMPEG_FLAGS="" ;;
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

need() { command -v "$1" >/dev/null 2>&1 || die "missing build tool: $1"; }
need curl; need tar; need make; need pkg-config; need meson; need ninja
[ "$PLATFORM" = macos ] || need patchelf
command -v nasm >/dev/null 2>&1 || command -v yasm >/dev/null 2>&1 \
  || die "missing build tool: nasm (or yasm) — ffmpeg's assembly needs one"

PREFIX="$WORK/prefix"
mkdir -p "$WORK" "$PREFIX"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

fetch() { # url sha256 dir
  local url="$1" sha="$2" dir="$3" file="$WORK/$(basename "$1")"
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
  [ -d "$WORK/$dir" ] && return 0
  [ -f "$file" ] || curl -fsSL "$url" -o "$file"
  if command -v shasum >/dev/null 2>&1; then
    echo "$sha  $file" | shasum -a 256 -c - >/dev/null \
      || die "checksum mismatch for $(basename "$url") — refusing to build it"
  fi
  tar -xf "$file" -C "$WORK"
}

# ── The LGPL-clean encoders that replace x264 and x265 ──────────────────────
# Named in docs/MEDIA_LICENSING.md: openh264 is Cisco's, BSD-2; kvazaar is
# LGPL-2.1. Without them an LGPL ffmpeg has NO software video encoder, and a
# machine with no hardware encoder cannot export at all.
log "openh264 $OPENH264_VERSION"
fetch "https://github.com/cisco/openh264/archive/refs/tags/v$OPENH264_VERSION.tar.gz" \
      "8ffbe944e74043d0d3fb53d4a2a14c94de71f58dbea6a06d0dc92369542958ea" "openh264-$OPENH264_VERSION"
make -C "$WORK/openh264-$OPENH264_VERSION" -j"$JOBS" PREFIX="$PREFIX" install-shared

log "kvazaar $KVAZAAR_VERSION"
fetch "https://github.com/ultravideo/kvazaar/releases/download/v$KVAZAAR_VERSION/kvazaar-$KVAZAAR_VERSION.tar.xz" \
      "ca30575026d2f1a1201af4b94697bb0fcd05913388008631dc3332bae94122bd" "kvazaar-$KVAZAAR_VERSION"
( cd "$WORK/kvazaar-$KVAZAAR_VERSION" \
  && ./configure --prefix="$PREFIX" --enable-shared --disable-static \
  && make -j"$JOBS" && make install )

# ── ffmpeg ─────────────────────────────────────────────────────────────────
log "ffmpeg $FFMPEG_VERSION (LGPL)"
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
      "733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1" "ffmpeg-$FFMPEG_VERSION"
(
  cd "$WORK/ffmpeg-$FFMPEG_VERSION"
  # --enable-shared --disable-static is not a size preference. LGPL-2.1 §6 is
  # satisfied by a library the user can REPLACE with their own build, and a
  # static link into a closed binary cannot be replaced.
  # --disable-autodetect is the whole hermeticity argument in one flag. Without
  # it configure enables whatever the build machine happens to have: the first
  # run picked up Homebrew's SDL2, libxcb and libX11 — none of them useful on a
  # Mac, none of them bundled, all of them absolute paths into /opt/homebrew.
  # With it, this bundle contains exactly what is named here and nothing else.
  ./configure \
    --prefix="$PREFIX" \
    --enable-shared --disable-static \
    --enable-pic \
    --disable-debug --disable-doc \
    --disable-autodetect \
    --enable-libopenh264 \
    --enable-libkvazaar \
    --enable-zlib --enable-bzlib --enable-iconv \
    $PLATFORM_FFMPEG_FLAGS \
    --disable-programs --enable-ffmpeg --enable-ffprobe \
    ${EXTRA_FFMPEG_FLAGS:-} 2>&1 | tee "$WORK/ffmpeg-configure.log"
  grep -q -- "--enable-gpl" config.h 2>/dev/null \
    && die "this ffmpeg configured itself GPL; the bundle cannot ship"
  make -j"$JOBS" && make install
)

# ── mpv ────────────────────────────────────────────────────────────────────
log "mpv $MPV_VERSION (LGPL, against the ffmpeg above)"
fetch "https://github.com/mpv-player/mpv/archive/refs/tags/v$MPV_VERSION.tar.gz" \
      "2ca92437affb62c2b559b4419ea4785c70d023590500e8a52e95ea3ab4554683" "mpv-$MPV_VERSION"
(
  cd "$WORK/mpv-$MPV_VERSION"
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
    --prefix="$PREFIX" --buildtype=release 2>&1 | tee "$WORK/mpv-meson.log"
  # meson prints its resolved options one per line; that is the line to read.
  # The first version grepped "gpl.*true" across the whole log and matched the
  # Build Options line — "-Dgpl=false … -Dlibmpv=true" — so it warned on every
  # correct build, which is how a warning stops being read.
  grep -qE '^[[:space:]]*gpl[[:space:]]*:[[:space:]]*true' build/meson-logs/meson-log.txt \
    && die "meson resolved gpl=true; a GPL mpv must not ship"
  ninja -C build -j"$JOBS" && ninja -C build install
)

# ── Stage the real closure, relocate it, and prove it ──────────────────────
# Without this the shipped ffmpeg looks for its dylibs in $PREFIX, which exists
# only on the build machine. It starts on the runner and dies on a customer's
# Mac with "Library not loaded" — a failure that no test on the build machine
# can see, and one the first version of this section did not prevent despite
# saying so. `verify_bundle` is the part that cannot quietly do nothing.

is_macho() { file -b "$1" 2>/dev/null | grep -q "Mach-O"; }

# What a Mach-O file records that it will load at run time. The first entry for
# a dylib is its own install name, which is why relocation sets that too.
macho_deps() { otool -L "$1" 2>/dev/null | tail -n +2 | awk '{print $1}'; }

# A path the customer's Mac will resolve without our help, or one already made
# relative to the bundle. Anything else is a path off this machine.
is_self_contained() {
  case "$1" in
    /usr/lib/*|/System/*|@rpath/*|@loader_path/*|@executable_path/*) return 0 ;;
    *) return 1 ;;
  esac
}

stage_closure() { # destdir binary...
  # Only the libraries the binaries actually load, followed transitively. The
  # first version copied all of $PREFIX/lib into both directories, which put
  # libmpv — and the claim to everything libmpv links — inside the ffmpeg
  # bundle. Each dependency is copied under the name it is recorded by, so a
  # symlinked soname becomes one real file rather than three copies.
  local dest="$1"; shift
  local src f dep base added=1
  for src in "$@"; do cp -L "$src" "$dest/$(basename "$src")"; done
  while [ "$added" = 1 ]; do
    added=0
    for f in "$dest"/*; do
      if [ ! -f "$f" ] || ! is_macho "$f"; then continue; fi
      for dep in $(macho_deps "$f"); do
        if is_self_contained "$dep"; then continue; fi
        base="$(basename "$dep")"
        if [ -e "$dest/$base" ] || [ ! -e "$dep" ]; then continue; fi
        # Only libraries this script built, from a pinned and checksummed
        # source. Left to itself this walk is happy to pull /opt/homebrew into
        # the bundle — it did, the first time the closure actually worked, and
        # produced an mpv carrying fourteen libraries nobody pinned. A source
        # offer has to name a version, and "whatever brew had that morning" is
        # not one. Anything outside $PREFIX is left dangling on purpose, and
        # verify_bundle then refuses to stage whatever depends on it.
        case "$dep" in "$PREFIX"/*) ;; *) continue ;; esac
        cp -L "$dep" "$dest/$base"
        added=1
      done
    done
  done
}

relocate() { # destdir
  local dest="$1" f dep base
  for f in "$dest"/*; do
    if [ ! -f "$f" ] || ! is_macho "$f"; then continue; fi
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
      patchelf --set-rpath '$ORIGIN' "$f" 2>/dev/null || true
    fi
  done
}

verify_bundle() { # destdir — 0 if nothing in it points off this machine
  local dest="$1" f dep bad=0
  # macOS only: measured here. The ELF equivalent is a NEEDED/RPATH walk and
  # has never been run, so it is not claimed.
  [ "$PLATFORM" = macos ] || return 0
  for f in "$dest"/*; do
    if [ ! -f "$f" ] || ! is_macho "$f"; then continue; fi
    for dep in $(macho_deps "$f"); do
      if is_self_contained "$dep"; then continue; fi
      printf '    %s → %s\n' "$(basename "$f")" "$dep" >&2
      bad=1
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

log "staging"
reset_stage_dir "$OUT/ffmpeg"
reset_stage_dir "$OUT/mpv"

stage_closure "$OUT/ffmpeg" "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe"
relocate "$OUT/ffmpeg"
if ! verify_bundle "$OUT/ffmpeg"; then
  # Cleared before dying. The release workflow runs this script with
  # continue-on-error, so a directory left populated by a failed run is a
  # broken ffmpeg inside a shipped installer — worse than no bundle at all.
  reset_stage_dir "$OUT/ffmpeg"
  die "the staged ffmpeg pointed off this machine (above); it would not start on a customer's Mac"
fi

# mpv is staged only if it comes out clean. It hard-requires libplacebo and
# libass — mpv 0.39 has no meson switch for either — and this script does not
# build them, so meson takes the build machine's copies. Whatever Homebrew had
# that morning is not a version a source offer can name. Shipping no mpv is
# exactly v0.0.6's behaviour; shipping one that cannot start, or one carrying a
# library we cannot honour, is not. See docs/MEDIA_LICENSING.md.
MPV_STAGED=no
if [ -x "$PREFIX/bin/mpv" ]; then
  stage_closure "$OUT/mpv" "$PREFIX/bin/mpv"
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
licence() { # src dest
  cp "$1" "$2" || die "missing licence text: $1 — LGPL-2.1 §6 needs it beside the binary"
}
mkdir -p "$OUT/ffmpeg/licences"
licence "$WORK/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$OUT/ffmpeg/licences/ffmpeg-COPYING.LGPLv2.1"
licence "$WORK/openh264-$OPENH264_VERSION/LICENSE"      "$OUT/ffmpeg/licences/openh264-LICENSE"
licence "$WORK/kvazaar-$KVAZAAR_VERSION/LICENSE"        "$OUT/ffmpeg/licences/kvazaar-LICENSE"
if [ "$MPV_STAGED" = yes ]; then
  mkdir -p "$OUT/mpv/licences"
  licence "$WORK/mpv-$MPV_VERSION/LICENSE.LGPL" "$OUT/mpv/licences/mpv-LICENSE.LGPL"
fi

# The manifest the About surface reads: what shipped, at which version, under
# which licence, and where the corresponding source is. Written by the build so
# it cannot drift from the binaries it describes.
MPV_COMPONENT=""
if [ "$MPV_STAGED" = yes ]; then
  MPV_COMPONENT='
    { "name": "mpv",       "version": "'"$MPV_VERSION"'",      "licence": "LGPL-2.1-or-later" },'
fi
cat > "$OUT/manifest.json" <<JSON
{
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platform": "$PLATFORM",
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
du -sh "$OUT/ffmpeg" "$OUT/mpv" 2>/dev/null || true
echo
echo "Read the dropped-component set off $WORK/ffmpeg-configure.log and record"
echo "it in docs/MEDIA_LICENSING.md — the spec asks for the measured list, not a guess."
