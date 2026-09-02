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
export function assetForPlatform(assets, { platform, arch } = {}) {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  const extension = platform === "darwin" ? ".dmg" : platform === "win32" ? ".exe" : ".AppImage";
  const candidates = assets.filter((asset) => typeof asset?.name === "string" && asset.name.endsWith(extension));
  if (candidates.length === 0) return null;

  // An Intel build running under Rosetta reports x64, and x64 is the build it
  // should be offered — so the reported architecture is taken at face value.
  const wanted = arch === "arm64" ? "arm64" : "x64";
  const exact = candidates.find((asset) => asset.name.includes(wanted));
  if (exact) return exact;

  // A build that names no architecture is for whatever this is — a universal
  // macOS binary, or Windows and Linux, which ship one each.
  const withoutArch = candidates.filter((asset) => !/arm64|x64/.test(asset.name));
  if (withoutArch.length === 1) return withoutArch[0];

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
  return /\.(dmg|exe|AppImage)$/i.test(resolved);
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
  if (typeof name !== "string" || !/^[\w.\- ]+\.(dmg|exe|AppImage)$/i.test(name)) {
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
