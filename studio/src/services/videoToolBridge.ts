/**
 * The renderer's half of the video tool bridge.
 *
 * Main forwards every external tool call here, because this process is the only
 * one that holds the timeline. Registering this is the difference between an
 * MCP client editing the project the operator can see and one editing an empty
 * store of its own.
 *
 * The chat does not come through here — the local Frontier engine runs in this
 * renderer and calls `executeTool` directly (see aiService). This exists for
 * the two engines that cannot: the Claude Code and Codex CLIs, which are real
 * processes with no access to any of this.
 *
 * Ported from teminaliCut/src/engine/toolBridgeClient.ts.
 */

import { executeTool, getToolManifest, isExposed, EXPOSED_TOOLS } from "../video/mcp/toolRegistry";

/**
 * What preload exposes. Declared here rather than added to `TeminaliBridge`,
 * which is the canonical type of that object: it lives in a component file, and
 * a title-bar component has no business knowing the panel has an MCP surface.
 */
interface VideoBridgeApi {
  onListTools: (listener: (id: string) => void) => void;
  onCallTool: (listener: (id: string, name: string, args: Record<string, unknown>) => void) => void;
  respond: (payload: { id: string; ok: boolean; data?: unknown; error?: string }) => void;
  ready: () => void;
}

function bridgeApi(): VideoBridgeApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window.teminali as unknown as { videoBridge?: VideoBridgeApi } | undefined)?.videoBridge;
}

export function registerVideoToolBridge(): void {
  const api = bridgeApi();
  if (!api) return; // a browser dev build, or the overlay surface. Nothing to serve

  api.onListTools((id) => {
    try {
      api.respond({ id, ok: true, data: getToolManifest() });
    } catch (error) {
      api.respond({ id, ok: false, error: (error as Error).message });
    }
  });

  api.onCallTool(async (id, name, args) => {
    /*
      The curated surface is enforced here, not in `executeTool`.

      An un-advertised tool is still callable by a client that knows its name,
      and the tools this registry grows next are import and export — the two
      that touch the operator's disk and want an approval gate before anything
      outside this window can reach them. The chat's in-process path is a
      different trust boundary and stays unrestricted.
    */
    if (!isExposed(name)) {
      api.respond({
        id,
        ok: true,
        data: {
          success: false,
          error: `"${name}" is not exposed over MCP. Available: ${EXPOSED_TOOLS.join(", ")}.`,
          durationMs: 0,
        },
      });
      return;
    }

    try {
      // `executeTool` catches per-tool failures and reports them in its result,
      // so a throw here means the call never ran at all.
      api.respond({ id, ok: true, data: await executeTool(name, args, "Agent CLI over MCP") });
    } catch (error) {
      api.respond({ id, ok: false, error: (error as Error).message });
    }
  });

  // Last, and only once the listeners above are installed: main refuses calls
  // until it hears this, so that a request arriving mid-boot is answered with
  // "still loading" instead of waiting out its whole timeout in silence.
  api.ready();
}
