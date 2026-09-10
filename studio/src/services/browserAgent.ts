import { GatewayClient } from "./gatewayClient";
import { browserViewBridge, type BrowserCdpOp, type BrowserCdpParams } from "./browserView";
import { targetBrowserPanelId } from "./browserNavigation";

/**
 * The window's half of the agent's browser control.
 *
 * The gateway is a plain Node process: it has no browser panel, and the panel
 * is a `WebContentsView` owned by main that only this renderer can reach. So a
 * `page_snapshot` arrives here as an event on this turn's own NDJSON stream,
 * and the answer goes back on its own POST — the same shape
 * `services/cameraFrame.ts` uses, and for the same reason: the stream is
 * one-way.
 *
 * Nothing here decides anything about the page. It resolves *which* panel, asks
 * the bridge, and posts what comes back. The protocol is spoken in exactly one
 * file (electron/browserCdp.cjs) and this is not it.
 */

/** Always resolved. `error` is a sentence written for the agent that asked. */
interface BrowserAnswer {
  result?: Record<string, unknown>;
  error?: string;
}

async function perform(op: BrowserCdpOp, params: BrowserCdpParams): Promise<BrowserAnswer> {
  const bridge = browserViewBridge();
  if (!bridge) {
    return { error: "This build has no browser panel, so there is no page to read." };
  }

  /*
    The same tab `browse` navigates, by construction: both ask
    `targetBrowserPanelId`. A second copy of that rule here would let the agent
    open one panel and read another, and it would read as a working turn.
  */
  const id = targetBrowserPanelId();
  if (!id) {
    /*
      No panel is opened for the agent. `browse` is the tool that puts a page
      in front of the operator, and it is the one they can see coming; opening
      a window from underneath a read-only tool would be a surprise, and the
      page it opened would be blank anyway.
    */
    return { error: "No browser panel is open. Call `browse` with an address first, then read the page." };
  }

  try {
    const answer = await bridge.cdp(id, op, params);
    if (!answer?.ok) return { error: answer?.error || "The browser panel refused that." };
    return { result: answer.result ?? {} };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The browser panel could not be reached." };
  }
}

/**
 * Answer one browser request from a live agent run.
 *
 * Never throws: every failure is a sentence the agent can act on, posted as
 * the answer. A failed POST is swallowed for the same reason the camera's is —
 * the bridge times out on its own, and a second failure here would reach
 * nobody.
 */
export async function answerBrowserRequest(
  runId: string,
  id: string,
  op: BrowserCdpOp,
  params: BrowserCdpParams = {},
): Promise<void> {
  const answer = await perform(op, params);
  try {
    await GatewayClient.request("/api/workspace/browser-action", {
      method: "POST",
      body: JSON.stringify({ runId, id, ...answer }),
    });
  } catch {
    /* The bridge times out on its own; a failed POST needs no second failure. */
  }
}
