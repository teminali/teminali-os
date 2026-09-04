/**
 * Updates, for the people running the app rather than the person shipping it.
 *
 * `releases.js` is the publishing half and talks to GitHub through the `gh`
 * CLI, which is correct there: cutting a release is an administrator action and
 * an administrator has gh authenticated. This half is the opposite case. It
 * runs on every install, on machines where gh does not exist and never will, so
 * it uses the public Releases API and no credential at all.
 *
 * The install is a **full asset replacement** — the whole .dmg / .exe /
 * .AppImage, every time. That is not a shortcut around a delta mechanism; it is
 * the only thing available. Squirrel-style in-place updating on macOS requires
 * the app to carry a Developer ID signature, this one is ad-hoc signed, and
 * Squirrel refuses to apply an update it cannot verify. Pretending otherwise
 * would produce a button that appears to work and silently never updates
 * anything.
 *
 * One consequence has to be handled rather than hidden: because each build is
 * ad-hoc signed, its signature differs from the last, and macOS keys
 * Screen Recording, Accessibility and Microphone grants to the signature. After
 * an update the operating system considers this a different application and the
 * grants are gone. The interface says so and offers a restart; the assistant's
 * own permission check (server/assistant.js) then reports the truth rather than
 * failing mysteriously.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { compareVersions, currentVersion, parseVersion } from "./releases.js";

export const UPDATE_LIMITS = Object.freeze({
  checkTimeoutMs: 10_000,
  /** A full application bundle. Generous, and still a ceiling. */
  maxAssetBytes: 600 * 1024 * 1024,
  /** Downloaded installers kept before the oldest is swept. */
  maxKeptDownloads: 2,
  /** Releases read when the version menu asks what it could go back to. */
  releasePageSize: 10,
});

/** Where a downloaded installer lands. Fixed, so the open route can verify it. */
export const UPDATE_DIRECTORY = resolve(tmpdir(), "teminali-updates");

/**
 * Which file this machine should download.
 *
 * Matched on extension and architecture token rather than on the full asset
 * name, because the name embeds the product name and the version and both
 * change. `Teminali.Code-1.0.1-macOS-arm64.dmg` and a rebranded successor must
 * both resolve, and a matcher built from the current product name would quietly
 * stop finding updates the day the product was renamed — which is exactly the
 * day this was written.
 */
/**
 * What each architecture is called in a file name.
 *
 * More than one spelling per architecture because the packagers disagree:
 * electron-builder writes `x64` into a .dmg and `x86_64` into an .AppImage, from
 * the same `${arch}` template. Matching only `x64` therefore found the macOS
 * build and missed the Linux one — which then fell through to the
 * "names no architecture" branch and worked by accident, right up until a
 * release shipped two Linux builds.
 *
 * `intel` and `apple-silicon` are the same architectures under the names a
 * person reads on the release page — build/afterAllArtifactBuild.cjs renames the
 * macOS disk images to use them. The machine spellings stay because v1.1.0 was
 * published as `-arm64.dmg` and `-x64.dmg`, and every copy of it in the world
 * looks for its successor through this function.
 *
 * Compared against a lower-cased name, so `Apple-Silicon` matches
 * `apple-silicon`. Every token here must therefore be lower case.
 */
const ARCH_TOKENS = Object.freeze({
  x64: ["x64", "x86_64", "amd64", "intel"],
  arm64: ["arm64", "aarch64", "apple-silicon", "applesilicon"],
});

/**
 * Derived rather than written out a second time. A token the matcher knows and
 * this pattern does not is not a near miss — the asset stops looking
 * architected, falls through to the branch below that offers a lone
 * unarchitected build to everyone, and an Intel Mac is handed an arm64 build.
 * That is the `x86_64` bug, and it is why these cannot be allowed to drift.
 * (Every token is plain text, so none of them needs escaping.)
 */
const ANY_ARCH = new RegExp(Object.values(ARCH_TOKENS).flat().join("|"));

export function assetForPlatform(assets, { platform, arch } = {}) {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  // macOS takes the .zip, not the .dmg. A .dmg can only be installed by handing
  // it to LaunchServices, and LaunchServices is exactly what Gatekeeper refuses
  // for an ad-hoc signed download — the user gets "Apple could not verify" with
  // no Open button. The .zip is expanded and swapped into place by this process
  // instead, which never asks LaunchServices anything. See installMacUpdate.
  const extension = platform === "darwin" ? ".zip" : platform === "win32" ? ".exe" : ".AppImage";
  // Lower-cased once here rather than at each comparison below, because the
  // architecture tokens are matched case-insensitively and the extension is not:
  // `.AppImage` is spelled the way the packager spells it.
  const candidates = assets
    .filter((asset) => typeof asset?.name === "string" && asset.name.endsWith(extension))
    .map((asset) => ({ asset, name: asset.name.toLowerCase() }));
  if (candidates.length === 0) return null;

  // An Intel build running under Rosetta reports x64, and x64 is the build it
  // should be offered — so the reported architecture is taken at face value.
  const wanted = ARCH_TOKENS[arch === "arm64" ? "arm64" : "x64"];
  const exact = candidates.find((candidate) => wanted.some((token) => candidate.name.includes(token)));
  if (exact) return exact.asset;

  // A build that names no architecture is for whatever this is — a universal
  // macOS binary, or Windows and Linux, which ship one each.
  const withoutArch = candidates.filter((candidate) => !ANY_ARCH.test(candidate.name));
  if (withoutArch.length === 1) return withoutArch[0].asset;

  // Everything left names an architecture, and none of them names this one.
  // Falling back to "there is only one, take it" would hand an Intel Mac an
  // arm64 build, which installs and then will not launch. Offering nothing is
  // the better failure, and the caller says so by name.
  return null;
}

function normaliseAsset(asset) {
  return {
    name: asset.name,
    size: typeof asset.size === "number" ? asset.size : null,
    url: asset.browser_download_url ?? null,
  };
}

/**
 * Is there a newer release?
 *
 * Never throws: "GitHub could not be reached" and "you are up to date" are
 * different answers and both are rendered, so the failure is returned rather
 * than raised.
 */
export async function checkForUpdate({
  appRoot,
  repo,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
} = {}) {
  const version = await currentVersion(appRoot);
  const answer = (extra) => ({
    version,
    latest: null,
    asset: null,
    updateAvailable: false,
    checkedAt: new Date().toISOString(),
    error: null,
    ...extra,
  });

  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "teminali-code-updater" },
      signal: AbortSignal.timeout(UPDATE_LIMITS.checkTimeoutMs),
    });

    if (response.status === 404) return answer({ error: "This repository has no releases yet." });
    if (response.status === 403) {
      // Unauthenticated callers get 60 requests an hour per address. Saying so
      // is better than reporting the machine offline when it is not.
      return answer({ error: "GitHub is rate-limiting update checks. Try again shortly." });
    }
    if (!response.ok) return answer({ error: `GitHub answered ${response.status}.` });

    const release = await response.json();
    if (release?.draft) return answer({});
    if (!parseVersion(release?.tag_name)) return answer({ error: "The latest release has no readable version." });

    const asset = assetForPlatform(release.assets, { platform, arch });
    return answer({
      latest: {
        tag: release.tag_name,
        name: release.name ?? release.tag_name,
        publishedAt: release.published_at ?? null,
        url: release.html_url ?? null,
        prerelease: Boolean(release.prerelease),
        notes: typeof release.body === "string" ? release.body.slice(0, 8_000) : "",
      },
      asset: asset ? normaliseAsset(asset) : null,
      updateAvailable: compareVersions(release.tag_name, version) > 0,
      // An update with nothing to download on this platform is worth naming.
      // Silently showing no button would read as "no update".
      error: asset || compareVersions(release.tag_name, version) <= 0
        ? null
        : `Release ${release.tag_name} has no build for ${platform}/${arch}.`,
    });
  } catch (error) {
    return answer({
      error: error?.name === "TimeoutError"
        ? "GitHub did not answer in time."
        : "GitHub could not be reached.",
    });
  }
}

/**
 * Every published release, newest first, each with the file this machine could
 * install — which is what makes going *backwards* possible.
 *
 * The check above asks GitHub for `releases/latest` and answers one question:
 * are you behind. That is the wrong shape for a rollback, because the version
 * somebody wants after a bad update is by definition not the latest one. This
 * reads the release list instead and marks each entry relative to the running
 * build, so the renderer never has to carry a second copy of the semver rules.
 *
 * When the running version cannot be read, `compareVersions` answers 0 for
 * everything and no release is marked `older` — so the menu offers no rollback
 * rather than offering to install something over an unknown build. That is the
 * failure worth having.
 *
 * Like the check, it never throws: "GitHub could not be reached" is an answer.
 */
export async function listReleases({
  appRoot,
  repo,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
} = {}) {
  const version = await currentVersion(appRoot);
  const answer = (extra) => ({
    version,
    releases: [],
    checkedAt: new Date().toISOString(),
    error: null,
    ...extra,
  });

  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo}/releases?per_page=${UPDATE_LIMITS.releasePageSize}`,
      {
        headers: { accept: "application/vnd.github+json", "user-agent": "teminali-code-updater" },
        signal: AbortSignal.timeout(UPDATE_LIMITS.checkTimeoutMs),
      },
    );

    if (response.status === 404) return answer({ error: "This repository has no releases yet." });
    if (response.status === 403) return answer({ error: "GitHub is rate-limiting update checks. Try again shortly." });
    if (!response.ok) return answer({ error: `GitHub answered ${response.status}.` });

    const body = await response.json();
    const releases = (Array.isArray(body) ? body : [])
      .filter((release) => !release?.draft && parseVersion(release?.tag_name))
      .map((release) => {
        const asset = assetForPlatform(release.assets, { platform, arch });
        // Against the running build: 0 is this one, below 0 is somewhere to go
        // back to, above 0 is an update and has its own route.
        const order = compareVersions(release.tag_name, version);
        return {
          tag: release.tag_name,
          version: String(release.tag_name).trim().replace(/^v/, ""),
          name: release.name ?? release.tag_name,
          publishedAt: release.published_at ?? null,
          url: release.html_url ?? null,
          prerelease: Boolean(release.prerelease),
          asset: asset ? normaliseAsset(asset) : null,
          current: order === 0,
          older: order < 0,
        };
      })
      // GitHub orders by publication date, which is the order they were cut and
      // not always the order they are numbered — a patch to an old line can be
      // published after a newer minor.
      .sort((a, b) => compareVersions(b.tag, a.tag));

    return answer({ releases });
  } catch (error) {
    return answer({
      error: error?.name === "TimeoutError" ? "GitHub did not answer in time." : "GitHub could not be reached.",
    });
  }
}

/** Keeps the temp directory from accumulating installers. */
async function pruneDownloads() {
  try {
    const entries = await readdir(UPDATE_DIRECTORY);
    const files = [];
    for (const name of entries) {
      const path = join(UPDATE_DIRECTORY, name);
      try {
        const info = await stat(path);
        if (info.isFile()) files.push({ path, at: info.mtimeMs });
      } catch {
        /* Gone already. */
      }
    }
    files.sort((a, b) => a.at - b.at);
    for (const stale of files.slice(0, Math.max(0, files.length - UPDATE_LIMITS.maxKeptDownloads))) {
      await rm(stale.path, { force: true });
    }
  } catch {
    /* Nothing to prune. */
  }
}

/**
 * Only a file this module put in its own directory may be handed to the
 * operating system to open. The renderer supplies the path, and a renderer that
 * could name any path would be a route for opening arbitrary files.
 */
export function isDownloadedInstaller(path) {
  if (typeof path !== "string" || !path || path.includes("\0")) return false;
  const resolved = resolve(path);
  const prefix = `${UPDATE_DIRECTORY}${sep}`;
  if (!resolved.startsWith(prefix)) return false;
  // Directly inside, not nested: this module only ever writes at the top level,
  // so a path with a separator left in it came from somewhere else.
  if (resolved.slice(prefix.length).includes(sep)) return false;
  return /\.(zip|dmg|exe|AppImage)$/i.test(resolved);
}

/**
 * Downloads one installer, reporting progress as it goes.
 *
 * Progress matters more than usual here: this is a 130 MB file on an
 * application whose whole update story is "replace the thing", and a button
 * that appears to do nothing for two minutes is a button people press again.
 */
export async function downloadAsset({ url, name, onProgress, signal, fetchImpl = globalThis.fetch }) {
  if (typeof url !== "string" || !/^https:\/\/[^/]*github(usercontent)?\.com\//.test(url)) {
    throw new Error("UPDATE_ASSET_URL_INVALID");
  }
  if (typeof name !== "string" || !/^[\w.\- ]+\.(zip|dmg|exe|AppImage)$/i.test(name)) {
    throw new Error("UPDATE_ASSET_NAME_INVALID");
  }

  await mkdir(UPDATE_DIRECTORY, { recursive: true });
  const destination = join(UPDATE_DIRECTORY, name);

  const response = await fetchImpl(url, {
    headers: { accept: "application/octet-stream", "user-agent": "teminali-code-updater" },
    redirect: "follow",
    signal,
  });
  if (!response.ok || !response.body) throw new Error("UPDATE_DOWNLOAD_FAILED");

  const total = Number(response.headers.get("content-length")) || null;
  if (total && total > UPDATE_LIMITS.maxAssetBytes) throw new Error("UPDATE_ASSET_TOO_LARGE");

  let received = 0;
  const counted = new ReadableStream({
    async start(controller) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > UPDATE_LIMITS.maxAssetBytes) {
          controller.error(new Error("UPDATE_ASSET_TOO_LARGE"));
          return;
        }
        onProgress?.({ received, total });
        controller.enqueue(value);
      }
      controller.close();
    },
  });

  await pipeline(Readable.fromWeb(counted), createWriteStream(destination), { signal });
  await pruneDownloads();
  return { path: destination, bytes: received };
}
