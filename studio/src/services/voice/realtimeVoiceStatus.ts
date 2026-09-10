/**
 * Where the realtime voice pipeline is, and whether it is up.
 *
 * The renderer used to carry `ws://localhost:8000/ws` as a literal, which made
 * the port a fact duplicated in two languages and meant a pipeline that was not
 * running looked, from the UI, exactly like one that was broken: a socket that
 * would not open and no way to say why.
 *
 * The gateway supervises the process, so the gateway is the only thing that can
 * answer both questions. Asking it costs one request at mount.
 */

import { GatewayClient } from "../gatewayClient";

/** Mirrors the supervisor's status object in `studio/server/realtime-voice.js`. */
export interface RealtimeVoiceStatus {
  enabled: boolean;
  /** stopped | starting | ready | unavailable | failed */
  state: string;
  reason: string;
  detail: string;
  adopted: boolean;
  supervised: boolean;
  ready: boolean;
  url: string;
  socketUrl: string;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  recentOutput: string[];
}

/**
 * The address used when the gateway cannot be reached at all — a renderer
 * running against a hand-started pipeline, which is how this was developed and
 * remains a supported way to work.
 */
export const FALLBACK_SOCKET_URL = "ws://127.0.0.1:8000/ws";

export function fallbackStatus(detail: string): RealtimeVoiceStatus {
  return {
    enabled: false,
    state: "unknown",
    reason: "gateway-unreachable",
    detail,
    adopted: false,
    supervised: false,
    ready: false,
    url: "",
    socketUrl: FALLBACK_SOCKET_URL,
    restarts: 0,
    lastExit: null,
    recentOutput: [],
  };
}

/**
 * Ask the gateway about the pipeline.
 *
 * Never throws: voice is one of several tiers and a status call that could
 * break the chat column would be worse than a stale default.
 */
export async function fetchRealtimeVoiceStatus(signal?: AbortSignal): Promise<RealtimeVoiceStatus> {
  try {
    const response = await GatewayClient.request("/api/voice/realtime/status", { method: "GET", signal });
    if (!response.ok) return fallbackStatus(`The gateway answered ${response.status} for the voice pipeline's status.`);
    const status = (await response.json()) as Partial<RealtimeVoiceStatus>;
    return {
      ...fallbackStatus(""),
      ...status,
      socketUrl: status.socketUrl || FALLBACK_SOCKET_URL,
    } as RealtimeVoiceStatus;
  } catch {
    return fallbackStatus("The gateway is not reachable; using the default voice address.");
  }
}

/**
 * A sentence for the operator, or "" when there is nothing worth saying.
 *
 * `ready` is silent on purpose — a working assistant should not narrate that it
 * is working. Every other state is something the user can act on.
 */
export function describeRealtimeVoice(status: RealtimeVoiceStatus): string {
  switch (status.state) {
    case "ready":
      return "";
    case "starting":
      return "Voice is starting — the speech models are loading.";
    case "unavailable":
      return status.detail || "The voice pipeline is not installed on this machine.";
    case "failed":
      return status.detail || "The voice pipeline failed to start.";
    case "stopped":
      return status.enabled ? "The voice pipeline is not running." : "Voice autostart is switched off.";
    default:
      return status.detail || "";
  }
}
