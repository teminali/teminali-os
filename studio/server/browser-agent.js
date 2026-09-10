/**
 * The browser panel's agent routes, decided rather than performed.
 *
 * Every route under `/api/workspace/agent/browser/` arrives here first: this
 * file says which named operation it means and what its arguments are, and
 * refuses the ones that cannot work — before a request goes anywhere near the
 * window, and before a page is touched.
 *
 * It does no I/O at all, which is the point. The transport (permission-bridge)
 * and the protocol (electron/browserCdp.cjs) are both testable only against a
 * live window; the decisions are testable under plain node, and they are where
 * the mistakes live. Same split `media-probe.js` and `player-state.js` already
 * make.
 *
 * ## The agent never names a CDP method
 *
 * A route maps to one of seven **named ops**. `browserCdp.cjs` composes each
 * one out of a fixed sequence of protocol commands, checked against an
 * allowlist on the way out. Nothing here, in the gateway, in the shim or in
 * the model's argument has any way to name a protocol command — so a tool that
 * reaches a new CDP domain is a change to that file and its test, never a
 * cleverly-shaped argument.
 *
 * ## Why the arguments are checked here and not only in main
 *
 * `browserCdp.cjs` refuses a bad ref too, and its refusals are better than
 * these — it knows what the page is showing. But a round trip to a window and
 * back costs the agent a wait, and half of these are settled by looking at the
 * argument: an empty `expression`, a `type` with nothing to type. A refusal
 * that could be written now should not cost a page visit.
 */

/**
 * The seven routes an agent CLI's browser shim may reach, and the only seven.
 *
 * Under `/api/workspace/agent/` rather than a namespace of their own, because
 * the browser panel *is* the workspace's browser: `browse` opens the page and
 * these read and drive the page it opened. They are token-checked by the same
 * `runAuthorises` and carry the same header as the workspace routes.
 */
export const BROWSER_AGENT_ROUTES = new Set([
  "/api/workspace/agent/browser/snapshot",
  "/api/workspace/agent/browser/read",
  "/api/workspace/agent/browser/screenshot",
  "/api/workspace/agent/browser/click",
  "/api/workspace/agent/browser/type",
  "/api/workspace/agent/browser/network",
  "/api/workspace/agent/browser/eval",
]);

/**
 * Route tail -> the op name `browserView.cjs` switches on.
 *
 * Deliberately one word apart from the tool names (`page_snapshot` minus its
 * prefix) so a reader can follow one word from the model's tool list to the
 * handler that answers it.
 */
const OPS = Object.freeze({
  snapshot: "snapshot",
  read: "read",
  screenshot: "screenshot",
  click: "click",
  type: "type",
  network: "network",
  eval: "eval",
});

/** The most network rows one call may ask for — `browserCdp.cjs` keeps 200. */
export const MAX_NETWORK_LIMIT = 200;

/** A refusal with a code the gateway turns into an HTTP status. */
export class BrowserActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserActionError";
    this.code = code;
  }
}

function text(value) {
  return typeof value === "string" ? value : "";
}

/**
 * What this route and this body mean: `{ op, params }`, or a refusal.
 *
 * Throws `BrowserActionError` rather than returning a shape, so a caller that
 * forgets to check gets a failure instead of sending `undefined` to a page.
 */
export function parseBrowserAction(route, body = {}) {
  const tail = String(route ?? "").split("/").pop();
  const op = OPS[tail];
  if (!op) throw new BrowserActionError("BROWSER_OP_UNKNOWN", `"${tail}" is not something the browser panel can do.`);

  switch (op) {
    case "snapshot":
    case "read":
      return { op, params: {} };

    case "screenshot":
      return { op, params: { fullPage: body?.fullPage === true } };

    case "click": {
      const ref = text(body?.ref).trim();
      if (!ref) {
        throw new BrowserActionError("BROWSER_REF_REQUIRED",
          "Give the `ref` of the element to click, from the last page_snapshot — such as \"e4\".");
      }
      const button = body?.button === "right" || body?.button === "middle" ? body.button : "left";
      return { op, params: { ref, button } };
    }

    case "type": {
      const ref = text(body?.ref).trim();
      if (!ref) {
        throw new BrowserActionError("BROWSER_REF_REQUIRED",
          "Give the `ref` of the field to type into, from the last page_snapshot — such as \"e4\".");
      }
      const value = text(body?.text);
      const submit = body?.submit === true;
      /*
        Neither text nor a submit is a call that focuses a field and does
        nothing else — which reports success, so the agent believes it typed.
        A refusal that names both ways out is cheaper than a silent no-op.
      */
      if (!value && !submit) {
        throw new BrowserActionError("BROWSER_TEXT_REQUIRED",
          "Give `text` to type, or `submit: true` to press Enter in the field as it stands.");
      }
      return { op, params: { ref, text: value, submit } };
    }

    case "network": {
      const asked = Number(body?.limit);
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_NETWORK_LIMIT) : 50;
      return { op, params: { limit, filter: text(body?.filter).trim() } };
    }

    case "eval": {
      const expression = text(body?.expression).trim();
      if (!expression) {
        throw new BrowserActionError("BROWSER_EXPRESSION_REQUIRED",
          "Give a JavaScript expression to evaluate in the page.");
      }
      return { op, params: { expression } };
    }

    default:
      /* Unreachable: `OPS` and this switch are the same seven names. */
      throw new BrowserActionError("BROWSER_OP_UNKNOWN", `"${op}" has no handler.`);
  }
}
