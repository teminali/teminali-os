/**
 * The assistant's calls into the gateway.
 *
 * Thin on purpose. The interesting decisions are either in the pure modules
 * beside this one (which elements to show a model, which steps to allow) or in
 * the gateway (which actions may actually reach the screen). This file is the
 * wire between them, and it holds no policy of its own.
 */

import { GatewayClient } from "../gatewayClient";
import type { AssistantCapabilities, Observation, PlanStep } from "./types";

/**
 * What the gateway reports about one executed step.
 *
 * Shape varies by kind and only `kind` is guaranteed. A `launch` also carries
 * `frontmost`, which is false when the application was started but had not come
 * to the front before the settle budget ran out — worth telling the operator,
 * because it is the difference between "it is open" and "it is opening".
 */
export interface StepResult {
  kind: string;
  frontmost?: boolean;
  [key: string]: unknown;
}

/** What the gateway returns: an observation, plus what it could not do. */
export interface ObservationResult extends Observation {
  /** Plain-language notes about a degraded look — a denied permission, mostly. */
  limits: string[];
}

export class AssistantService {
  /** Never throws: "not supported here" and "not built yet" are both answers. */
  public static async capabilities(signal?: AbortSignal): Promise<AssistantCapabilities> {
    try {
      const response = await GatewayClient.request("/api/assistant/capabilities", { method: "GET", signal });
      if (!response.ok) throw new Error("unavailable");
      return (await response.json()) as AssistantCapabilities;
    } catch {
      return {
        supported: false,
        helperBuilt: false,
        accessibilityTrusted: false,
        screenRecordingGranted: false,
        detail: "The local gateway is not answering, so screen access cannot be checked.",
      };
    }
  }

  /**
   * Raises the operating system's own Accessibility dialog.
   *
   * Only ever called from an explicit operator action. macOS shows this once
   * per application and then stops; firing it on a poll would spend that one
   * chance on a moment nobody was looking at.
   */
  public static async requestPermissions(): Promise<AssistantCapabilities> {
    const response = await GatewayClient.request("/api/assistant/permissions", { method: "POST" });
    await GatewayClient.expectOk(response);
    return (await response.json()) as AssistantCapabilities;
  }

  /** One look at the screen. */
  public static async observe(
    options: { maxElements?: number; describe?: boolean; pid?: number | null } = {},
    signal?: AbortSignal,
  ): Promise<ObservationResult> {
    const response = await GatewayClient.request("/api/assistant/observe", {
      method: "POST",
      signal,
      body: JSON.stringify({
        maxElements: options.maxElements ?? 120,
        describe: options.describe !== false,
        // Omitted means "whichever application is in front", which is the right
        // answer almost always. It is sent only when the caller knows the
        // operator meant a different window than the one now in front.
        ...(typeof options.pid === "number" && options.pid > 0 ? { pid: options.pid } : {}),
      }),
    });
    await GatewayClient.expectOk(response);
    const payload = (await response.json()) as ObservationResult;
    return { ...payload, limits: Array.isArray(payload.limits) ? payload.limits : [] };
  }

  /**
   * Executes one step.
   *
   * The step travels with the id of the observation it came from, and the
   * gateway resolves the element against that snapshot. Nothing here sends a
   * coordinate, because there is no route that would accept one.
   */
  public static async act(observationId: string, step: PlanStep, signal?: AbortSignal): Promise<StepResult | null> {
    const response = await GatewayClient.request("/api/assistant/act", {
      method: "POST",
      signal,
      body: JSON.stringify({ observationId, step }),
    });
    await GatewayClient.expectOk(response);
    const payload = (await response.json()) as { result?: StepResult };
    return payload?.result ?? null;
  }
}
