import { GatewayClient } from "./gatewayClient";

/**
 * What this build is, and what it ships that somebody else wrote.
 *
 * The second half is a licence obligation rather than a courtesy. The
 * installers carry an LGPL-2.1 FFmpeg built by `scripts/build-media-stack.sh`,
 * and §6 of that licence is met only when the shipped components are named
 * with their versions and the corresponding source is offered — see
 * `docs/MEDIA_LICENSING.md`, which treats this surface as the shipping blocker.
 *
 * Read from the gateway, not compiled in: the build script writes the manifest
 * beside the binaries it produced, so the list cannot drift from what actually
 * shipped.
 */

/** One thing in the bundle that somebody else wrote. */
export interface AboutComponent {
  name: string;
  version: string | null;
  licence: string | null;
}

/** A licence text that shipped, by the bundle that carries it. */
export interface AboutLicence {
  bundle: string;
  file: string;
}

export interface MediaStackInfo {
  /** False for a build made without the media-stack script — every release up to v0.0.6. */
  bundled: boolean;
  platform: string | null;
  builtAt: string | null;
  buildScript: string | null;
  /** Where the corresponding source lives. Null is a licence problem, not a display problem. */
  sourceOffer: string | null;
  components: AboutComponent[];
  licences: AboutLicence[];
}

export interface AboutInfo {
  app: {
    name: string;
    version: string | null;
    platform: string;
    arch: string;
    electron: string | null;
    chrome: string | null;
    node: string;
  };
  mediaStack: MediaStackInfo;
}

export class AboutService {
  public static async read(signal?: AbortSignal): Promise<AboutInfo | null> {
    try {
      const response = await GatewayClient.request("/api/about", { method: "GET", signal });
      if (!response.ok) return null;
      return (await response.json()) as AboutInfo;
    } catch {
      return null;
    }
  }

  /** One shipped licence, verbatim. Null when this build does not carry it. */
  public static async licence(bundle: string, file: string, signal?: AbortSignal): Promise<string | null> {
    const query = new URLSearchParams({ bundle, file });
    try {
      const response = await GatewayClient.request(`/api/about/licence?${query}`, { method: "GET", signal });
      if (!response.ok) return null;
      const body = (await response.json()) as { text?: string };
      return typeof body.text === "string" ? body.text : null;
    } catch {
      return null;
    }
  }
}
