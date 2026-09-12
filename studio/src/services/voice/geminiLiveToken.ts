/**
 * The ephemeral token that lets the renderer open a Gemini Live session.
 *
 * The renderer must never hold the Gemini API key. It holds a short-lived
 * token minted by the gateway instead: `uses: 1`, roughly 30 minutes of life.
 * That is the whole reason this module exists — the browser half of the voice
 * lane needs credentials, and the only credential it is allowed to see is one
 * that expires and cannot be replayed.
 *
 * This replaces `fetchRealtimeVoiceStatus`, which asked the gateway where the
 * local Python pipeline was and whether it was up. There is no local pipeline
 * any more, so there is no address to discover and no process to supervise;
 * the only question left is "can I authenticate", and its answer is a token.
 *
 * Single-use is load-bearing for the caller: a reconnect must fetch a fresh
 * token, never reuse the one it already spent. `geminiLiveEngine.ts` does.
 */

import { GatewayClient } from "../gatewayClient.ts";

/** The success shape of `GET /api/voice/realtime/token`. */
export interface GeminiLiveToken {
  ok: true;
  /** The ephemeral token string, passed to `new GoogleGenAI({ apiKey })`. */
  token: string;
  /** The Live model the gateway minted the token for. */
  model: string;
  /** The prebuilt voice name the gateway wants used for this session. */
  voice: string;
  /** ISO-8601. Informational — the SDK finds out by being refused. */
  expiresAt: string;
}

/** The failure shape. The route answers HTTP 200 with this; see below. */
export interface GeminiLiveTokenFailure {
  ok: false;
  /** A machine-readable cause: `no-key`, `gateway-unreachable`, ... */
  reason: string;
  /** A sentence with the specifics, safe to show an operator. */
  detail: string;
}

export type GeminiLiveTokenResult = GeminiLiveToken | GeminiLiveTokenFailure;

function failure(reason: string, detail: string): GeminiLiveTokenFailure {
  return { ok: false, reason, detail };
}

/**
 * Ask the gateway to mint a token.
 *
 * Never throws. Voice is a degradable tier of Teminali OS, not a dependency of
 * it: a missing Gemini key should cost the operator the microphone and nothing
 * else, so every failure path here comes back as a value the caller can render.
 * The route itself answers HTTP 200 with `{ ok: false }` for the same reason —
 * a non-2xx would make an unconfigured machine indistinguishable from a broken
 * one in every fetch wrapper between here and the panel.
 *
 * A non-200 therefore means the gateway itself is wrong, not the key.
 */
export async function fetchGeminiLiveToken(signal?: AbortSignal): Promise<GeminiLiveTokenResult> {
  let response: Response;
  try {
    response = await GatewayClient.request("/api/voice/realtime/token", { method: "GET", signal });
  } catch {
    return failure("gateway-unreachable", "The local Frontier gateway is not reachable, so voice cannot authenticate.");
  }

  if (!response.ok) {
    return failure("gateway-error", `The gateway answered ${response.status} when asked for a voice token.`);
  }

  let body: Partial<GeminiLiveToken> & Partial<GeminiLiveTokenFailure>;
  try {
    body = (await response.json()) as Partial<GeminiLiveToken> & Partial<GeminiLiveTokenFailure>;
  } catch {
    return failure("gateway-error", "The gateway's voice token response was not JSON.");
  }

  if (body.ok !== true) {
    return failure(body.reason || "unknown", body.detail || "The gateway declined to mint a voice token.");
  }
  // A token-shaped success with no token in it is a failure wearing the wrong
  // hat; catching it here keeps the engine from opening a session that can only
  // close on an auth error thirty seconds later.
  if (!body.token) {
    return failure("no-token", "The gateway reported success but returned no voice token.");
  }

  return {
    ok: true,
    token: body.token,
    model: body.model || "",
    voice: body.voice || "",
    expiresAt: body.expiresAt || "",
  };
}

/**
 * Something the operator can press, for the failures a press can actually fix.
 *
 * Only `no-key` has one. "The gateway is not running" is equally actionable in
 * prose and completely unactionable in the interface: a button that opens a key
 * field would not start a gateway, and a button that does nothing is worse than
 * no button at all. `quota` is deliberately out too: the modal behind
 * `gemini-key` does take a backup key, but that branch renders the server's own
 * `detail` and so has no stable sentence to key off.
 */
export type GeminiLiveRemedy = "gemini-key";

/**
 * The `no-key` sentence, named so the remedy can be looked up by identity.
 *
 * The caller that renders this note is three modules away and receives a
 * string: `GeminiLiveEngine.onNote` is typed `(note: string) => void`, and the
 * engine builds the argument, so there is no widening that carries the reason
 * across without the engine's help. Matching the sentence would normally rot
 * the first time someone rewrites the copy, which is exactly why the sentence
 * is a constant here: a rewrite moves the note and the lookup together, in one
 * edit, because they are the same string.
 */
export const GEMINI_LIVE_NO_KEY_NOTE = "Voice needs a Gemini API key. Add one to switch Temi on.";

/** What the operator can do about a note, or null when it is only news. */
export function geminiLiveRemedy(note: string): GeminiLiveRemedy | null {
  return note === GEMINI_LIVE_NO_KEY_NOTE ? "gemini-key" : null;
}

/**
 * A sentence for the operator, or "" when there is nothing worth saying.
 *
 * Success is silent on purpose — this is `describeRealtimeVoice`'s rule kept
 * intact: a working assistant should not narrate that it is working. Every
 * other branch has to be something the operator can act on, which is why
 * `no-key` names the fix rather than just reporting the absence.
 */
export function describeGeminiLive(result: GeminiLiveTokenResult): string {
  if (result.ok) return "";
  switch (result.reason) {
    case "no-key":
      return GEMINI_LIVE_NO_KEY_NOTE;
    case "gateway-unreachable":
      return "Voice cannot start: the local gateway is not running.";
    case "gateway-error":
    case "no-token":
      return result.detail || "Voice could not get a session token from the gateway.";
    case "quota":
      return result.detail || "Gemini refused the voice session: the account is out of quota.";
    default:
      return result.detail || "Voice is unavailable.";
  }
}
