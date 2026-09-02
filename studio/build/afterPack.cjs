const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ENTITLEMENTS = path.join(__dirname, 'entitlements.mac.plist');

/* Ad-hoc signs the macOS build, inside out.
 *
 * Two things this has to get right, both of which the previous one-liner got
 * wrong:
 *
 *   1. `--entitlements`. Without it the signature carries none, and
 *      entitlements.mac.plist is decoration. macOS reads Apple Events and
 *      library-validation permission out of the signature, not out of a file in
 *      build/, so an app signed without them cannot even ask for those
 *      permissions — the dialog never appears. The shipped 1.1.x builds had an
 *      empty entitlement set for exactly this reason.
 *
 *   2. Order. `--deep` is Apple's legacy shortcut and Electron's documentation
 *      says never to use it: it signs nested code with the outer invocation's
 *      arguments and seals parents before their children. Code has to be signed
 *      from the inside out, so this walks the bundle deepest-first and signs the
 *      .app last.
 *
 * Entitlements go on the app and its helper apps only. A framework or a bare
 * dylib is not an executable target and codesign rejects the pairing.
 */

const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

/** True for a Mach-O image, including the extension-less ones in Helpers/. */
function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    return MACHO_MAGIC.has(head.readUInt32BE(0)) || MACHO_MAGIC.has(head.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Every Mach-O inside `dir`, deepest first, not descending into bundles that
 * get signed as a unit. `intoFrameworks` is what makes
 * `Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler`
 * reachable — leave it unsigned and signing the framework fails outright with
 * "code object is not signed at all".
 */
function machOFiles(dir, { intoFrameworks = false } = {}, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.isSymbolicLink());

  // Subdirectories before this level's own files, so a framework's main binary
  // is signed after the Helpers/ and Libraries/ it seals. Signing it first
  // fails the framework with "code object is not signed at all".
  for (const entry of entries.filter((e) => e.isDirectory())) {
    if (entry.name.endsWith('.app')) continue;
    if (entry.name.endsWith('.framework') && !intoFrameworks) continue;
    machOFiles(path.join(dir, entry.name), { intoFrameworks }, out);
  }
  for (const entry of entries.filter((e) => e.isFile())) {
    const full = path.join(dir, entry.name);
    if (isMachO(full)) out.push(full);
  }
  return out;
}

function sign(target, label, entitlements) {
  const args = ['--force', '--sign', '-', '--timestamp=none'];
  if (entitlements) args.push('--entitlements', ENTITLEMENTS);
  execFileSync('codesign', [...args, target], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`  • signed ${label}${entitlements ? ' (with entitlements)' : ''}`);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // A real Developer ID is present: electron-builder signs it properly, with the
  // entitlements from electron-builder.yml. Stay out of the way.
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const contents = path.join(appPath, 'Contents');
  const frameworks = path.join(contents, 'Frameworks');
  const resources = path.join(contents, 'Resources');

  /** @type {[string, string, boolean][]} target, label, entitlements */
  const targets = [];
  const rel = (f) => path.relative(contents, f);

  // 1. Code nested inside the frameworks, before the frameworks that seal it.
  for (const file of machOFiles(frameworks, { intoFrameworks: true })) {
    targets.push([file, rel(file), false]);
  }

  // 2. Native modules and dylibs unpacked out of the asar.
  for (const file of machOFiles(resources)) targets.push([file, rel(file), false]);

  // 3. The compiled pointer helper, which ships beside the asar because macOS
  //    will not execute a binary from inside an archive.
  const pointer = path.join(resources, 'pointer', 'teminali-pointer');
  if (fs.existsSync(pointer)) targets.push([pointer, rel(pointer), false]);

  // 4. The framework bundles, then the helper apps that link them.
  if (fs.existsSync(frameworks)) {
    const entries = fs.readdirSync(frameworks);
    for (const name of entries.filter((n) => n.endsWith('.framework'))) {
      targets.push([path.join(frameworks, name), name, false]);
    }
    for (const name of entries.filter((n) => n.endsWith('.app'))) {
      targets.push([path.join(frameworks, name), name, true]);
    }
  }

  // 5. The outer bundle last, sealing everything above.
  targets.push([appPath, path.basename(appPath), true]);

  for (const [target, label, entitlements] of targets) {
    try {
      sign(target, label, entitlements);
    } catch (err) {
      const detail = err.stderr ? err.stderr.toString().trim() : err.message;
      // Deliberately fatal. A warning here is how a build that cannot run ships
      // anyway; the release is worth less than the failure is worth catching.
      throw new Error(`ad-hoc signing failed for ${label}: ${detail}`);
    }
  }

  // Prove the entitlements reached the signature. Silent, empty entitlements
  // are the exact failure this hook was rewritten to fix, so it does not get to
  // report success without checking.
  const carried = execFileSync('codesign', ['-d', '--entitlements', ':-', appPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (!carried.includes('com.apple.security.automation.apple-events')) {
    throw new Error('the signature carries no entitlements');
  }
  execFileSync('codesign', ['--verify', '--strict', appPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log('  • entitlements verified in signature; bundle verifies');
};
