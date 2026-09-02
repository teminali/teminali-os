const { rename } = require('node:fs/promises');
const path = require('node:path');

/**
 * Names the macOS disk images after the Mac they run on.
 *
 * `Teminali-Code-1.1.0-macOS-arm64.dmg` tells someone standing on the release
 * page nothing about which of the two files to click. These become
 * `-Apple-Silicon.dmg` and `-Intel.dmg`, which is what the download button on
 * an Apple support page would say.
 *
 * It is a rename rather than a name, because electron-builder's `artifactName`
 * template has no conditional: `${arch}` expands to whatever the packager calls
 * the architecture and there is no hook into that expansion. Both DMGs come out
 * of a single `--mac --arm64 --x64` invocation, so per-arch config would mean
 * per-arch invocations.
 *
 * Renaming an artifact after the fact is only safe because `dmg.publish` is
 * null in electron-builder.yml. The builder queues each upload the moment a
 * file is created and waits for those uploads *after* this hook runs, so a
 * rename here would either race an in-flight upload of the old name or leave
 * both names on the release. With the DMG excluded from its publisher, nothing
 * is uploaded until this returns, and what it returns is what gets uploaded.
 */

/** What each architecture is called once the file is on the release page. */
const LABELS = { arm64: 'Apple-Silicon', x64: 'Intel' };

/**
 * Anchored at the end so only the architecture electron-builder appended is
 * rewritten — a product name or version that happened to contain "-x64" is
 * left alone. The blockmap is carried along because it is named after the file
 * it describes, and a blockmap whose subject no longer exists is litter.
 */
const ARCH_SUFFIX = /-(arm64|x64)\.dmg(\.blockmap)?$/;

function relabel(file) {
  const match = ARCH_SUFFIX.exec(file);
  if (match === null) return null;

  const renamed = file.replace(ARCH_SUFFIX, `-${LABELS[match[1]]}.dmg${match[2] ?? ''}`);
  return path.join(path.dirname(renamed), githubSafe(path.basename(renamed)));
}

/**
 * The product name has a space in it, and GitHub does not accept one in an
 * asset name — it substitutes a dot, so the file arrives as
 * `Teminali.Code-...dmg` while its neighbours are `Teminali-Code-...`.
 *
 * electron-builder normally spares us this: it computes a safe name alongside
 * each artifact and uploads under that. Artifacts handed back from this hook do
 * not carry one, and the publisher falls back to the name on disk. So the name
 * on disk has to be the safe one. This is the same substitution
 * `computeSafeArtifactNameIfNeeded` makes, and it is what put the hyphens in
 * every asset of v1.1.0.
 */
function githubSafe(name) {
  return name.replace(/ /g, '-');
}

exports.default = async function afterAllArtifactBuild(result) {
  const renamed = [];

  for (const from of result.artifactPaths) {
    const to = relabel(from);
    if (to === null) continue;
    await rename(from, to);
    renamed.push([from, to]);
  }

  for (const [from, to] of renamed) {
    // Dropped from the build result for two reasons: the summary
    // electron-builder prints at the end should name files that exist, and it
    // skips any returned path already in this list as "already published",
    // which would silently publish nothing at all.
    result.artifactPaths.splice(result.artifactPaths.indexOf(from), 1);
    console.log(`  • ${path.basename(from)} → ${path.basename(to)}`);
  }

  return renamed.map(([, to]) => to);
};
