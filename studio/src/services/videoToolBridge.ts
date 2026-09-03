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

import { executeTool, getTool, getToolManifest, isExposed, EXPOSED_TOOLS } from "../video/mcp/toolRegistry";
import { mediaConsentGate } from "./mediaConsent";

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

/**
 * Who the operator sees in the prompt.
 *
 * Deliberately not the chat's name: a call from the sentence they just
 * typed is not a call from a process running unattended in another
 * application, and they should be able to tell the two apart at a glance.
 */
const AGENT_NAME = "Agent CLI over MCP";

/**
 * The paths a call would touch, as the tool itself declares them.
 *
 * Parsed through the tool's own schema first. `consentPaths` reads typed
 * fields, so handing it raw arguments would turn a malformed call into a
 * crash in the gate instead of the schema error `executeTool` is about to
 * return. A call that does not parse touches no path, and is refused a
 * few lines later by that error.
 */
function pathsFor(tool: NonNullable<ReturnType<typeof getTool>>, args: Record<string, unknown>) {
  const parsed = (tool.exposedSchema ?? tool.schema).safeParse(args ?? {});
  if (!parsed.success || !tool.consentPaths) return [];
  return tool.consentPaths(parsed.data);
}

function detailFor(tool: NonNullable<ReturnType<typeof getTool>>, args: Record<string, unknown>) {
  const parsed = (tool.exposedSchema ?? tool.schema).safeParse(args ?? {});
  return parsed.success ? tool.consentDetail?.(parsed.data) : undefined;
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

    /*
      Consent, second.

      This is the only place it can be. The CLI's own permission model is
      already spent — `server/video-mcp.js:158` passes
      `--allowedTools mcp__cut`, which names the SERVER, so every tool it
      serves is pre-approved. That flag is correct and it stays: headless
      `claude -p` has no TTY, and without it the first tool call is
      refused and the turn ends having done nothing. What it means is that
      the CLI will never ask, so the gate has to be on this side of the
      bridge.

      The call BLOCKS while the operator decides. That is the honest
      representation of "a person has to decide" — a protocol that lets
      the agent proceed while the question is open is a gate that can be
      waited out. `electron/videoToolBridge.cjs` gives these two tools
      their own `SLOW_TOOLS` entries so the bridge's 20s default (chosen
      for in-memory writes) does not answer the caller while the prompt
      is still on screen, and the gate's own deadline is what stops a
      blocked call from becoming a wedged CLI.
    */
    const tool = getTool(name);
    if (tool?.consent?.length) {
      const gate = mediaConsentGate();
      const verdict = await gate.request({
        tool: name,
        agentName: AGENT_NAME,
        capabilities: tool.consent,
        // `safeParse` rather than the raw args: `consentPaths` reads
        // typed fields, and a malformed call must be a schema error from
        // `executeTool`, not a crash in the gate on its way there.
        paths: pathsFor(tool, args),
        detail: detailFor(tool, args),
      });

      if (!verdict.allowed) {
        api.respond({
          id,
          ok: true,
          data: { success: false, error: verdict.message ?? "Refused.", durationMs: 0 },
        });
        return;
      }
    }

    try {
      // `executeTool` catches per-tool failures and reports them in its result,
      // so a throw here means the call never ran at all.
      api.respond({ id, ok: true, data: await executeTool(name, args, AGENT_NAME, { external: true }) });
    } catch (error) {
      api.respond({ id, ok: false, error: (error as Error).message });
    }
  });

  // Last, and only once the listeners above are installed: main refuses calls
  // until it hears this, so that a request arriving mid-boot is answered with
  // "still loading" instead of waiting out its whole timeout in silence.
  api.ready();
}
