/*
  The licence posture of the bundled media stack, asserted against the recipe.

  `scripts/build-media-stack.sh` is the one file in this repository where a
  one-word edit relicenses a closed, sold product as GPL, and nothing at run
  time would say so: a GPL ffmpeg encodes exactly like an LGPL one. The only
  signal is the configure line, so that is what this reads.

  Every assertion here comes from something the first real run of that script
  actually did, on macOS, 2026-09-11:

    • It absorbed the build machine. mpv's meson options default to `auto`,
      which means "link it if this machine has it" — so it linked Homebrew's
      librubberband, GPL-2.0-or-later, into a build whose whole point was
      LGPL. `-Dgpl=false` does not gate that; it governs mpv's own GPL source,
      not what it links against. ffmpeg did the same with SDL2 and libX11,
      which were merely useless rather than fatal.
    • Its checksums were `SET_ME` placeholders. A source offer that cannot
      name the bytes it built is not an offer.

  Nothing here builds anything. It reads the recipe the way a reviewer would,
  which is the only reading available before a release is already out.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RECIPE = readFileSync(
  join(import.meta.dirname, "..", "scripts", "build-media-stack.sh"),
  "utf8",
);

/** The script with its comment lines removed — what actually runs. */
const CODE = RECIPE.split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

/**
 * The flags actually handed to ffmpeg's configure. Read as a block rather than
 * searched for across the whole file, because the script also greps the built
 * `config.h` for `--enable-gpl` — a mention of the flag is how it catches one,
 * so a whole-file search finds the guard and calls it the offence.
 */
const FFMPEG_CONFIGURE = CODE.match(
  /\.\/configure \\[\s\S]*?ffmpeg-configure\.log/,
)?.[0];

test("the ffmpeg it builds is never GPL, and never nonfree", () => {
  assert.ok(FFMPEG_CONFIGURE, "no ffmpeg configure invocation found");
  assert.doesNotMatch(FFMPEG_CONFIGURE, /--enable-gpl\b/);
  // Not a licence at all: --enable-nonfree produces a binary that cannot be
  // distributed under any terms, which is worse than the GPL case because
  // there is no compliance step that fixes it afterwards.
  assert.doesNotMatch(FFMPEG_CONFIGURE, /--enable-nonfree\b/);
  // And the run-time guard that reads it back off the built config stays.
  assert.match(CODE, /grep -q -- "--enable-gpl" config\.h[\s\S]{0,80}die/);
});

test("ffmpeg states its external libraries instead of detecting them", () => {
  assert.match(FFMPEG_CONFIGURE, /--disable-autodetect\b/);
  // The two that replace x264/x265. Without them an LGPL ffmpeg has no
  // software video encoder at all, and a machine with no hardware encoder
  // cannot export.
  assert.match(CODE, /--enable-libopenh264\b/);
  assert.match(CODE, /--enable-libkvazaar\b/);
  // The hardware encoder the exporter prefers on a Mac. --disable-autodetect
  // turns this off too, so it has to be asked for by name.
  assert.match(CODE, /--enable-videotoolbox\b/);
});

test("mpv is built LGPL and refuses the GPL library it once absorbed", () => {
  assert.match(CODE, /-Dgpl=false\b/);
  assert.match(CODE, /-Drubberband=disabled\b/);
});

test("every optional mpv dependency is stated, not left to the machine", () => {
  // Each of these defaults to `auto` in mpv 0.39's meson_options.txt. An
  // unstated one is a library this script does not build appearing in the
  // shipped binary as an absolute path into the build machine's /opt.
  for (const option of [
    "libbluray",
    "uchardet",
    "zimg",
    "javascript",
    "lua",
    "lcms2",
    "libarchive",
    "vapoursynth",
    "sdl2",
    "vulkan",
    "shaderc",
    "spirv-cross",
    "jpeg",
  ]) {
    assert.match(
      CODE,
      new RegExp(`-D${option}=disabled\\b`),
      `mpv option ${option} is left at 'auto', so the build machine decides it`,
    );
  }
});

test("every source is pinned to a checksum that was measured", () => {
  const fetches = [...CODE.matchAll(/^fetch "([^"]+)" \\\n\s+"([^"]+)"/gm)];
  assert.equal(fetches.length, 4, "expected four pinned sources");

  for (const [, url, sha] of fetches) {
    assert.doesNotMatch(sha, /^SET_ME/, `${url} still has a placeholder checksum`);
    assert.match(sha, /^[0-9a-f]{64}$/, `${url} has no sha256`);
  }

  // The guard that stops a version bump from shipping unpinned bytes stays in
  // the script even though no placeholder is left to catch today.
  assert.match(CODE, /SET_ME\*\)\s*die/);
});

test("the bundle is proved self-contained before it is allowed to ship", () => {
  // The first version of the relocation step rewrote the path each library
  // was COPIED to rather than the path it was LINKED against, so it matched
  // nothing and every staged binary still pointed into the build tree. It
  // reported success. This is the check that cannot quietly do nothing.
  // assert.ok rather than assert.match throughout this file: a failing
  // assert.match prints the whole script as `actual`, which buries the one
  // line that matters under four hundred that do not.
  assert.ok(
    CODE.includes('verify_bundle "$OUT/ffmpeg"'),
    "the staged ffmpeg is never checked for paths off the build machine",
  );
  assert.ok(
    /verify_bundle "\$OUT\/ffmpeg"[\s\S]{0,300}?\bdie\b/.test(CODE),
    "verify_bundle's verdict on ffmpeg does not reach die — a failed check that "
      + "only warns is the no-op this test exists to prevent",
  );
});

test("the source offer names a real place", () => {
  const offer = CODE.match(/MEDIA_STACK_SOURCE_OFFER="\$\{MEDIA_STACK_SOURCE_OFFER:-([^}]*)\}"/);
  assert.ok(offer, "MEDIA_STACK_SOURCE_OFFER is not defined");
  assert.match(
    offer[1],
    /^https:\/\/\S+$/,
    "LGPL-2.1 §6 wants an offer at a URL that outlives the release",
  );
});
