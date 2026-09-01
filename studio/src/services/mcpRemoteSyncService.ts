import { GatewayClient, GatewayError } from "./gatewayClient";

export interface MCPTimelineTrack {
  id: string;
  type: "video" | "audio" | "text_caption";
  name: string;
  durationSec: number;
  clipsCount: number;
  volumeDb: number;
}

export interface MCPSilenceCutResult {
  trackId: string;
  cutsApplied: number;
  durationSavedSec: number;
  downbeatsAligned: number;
  bpm: number;
}

export interface MCPConnectionStatus {
  connected: boolean;
  latencyMs: number;
  detail: string;
  checkedAt: string;
}

interface McpEnvelope<T> {
  result?: T;
  error?: { code?: string; message?: string };
}

function isSilenceResult(value: unknown): value is MCPSilenceCutResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.trackId === "string"
    && typeof item.cutsApplied === "number"
    && typeof item.durationSavedSec === "number"
    && typeof item.downbeatsAligned === "number"
    && typeof item.bpm === "number";
}

function isTimelineTrack(value: unknown): value is MCPTimelineTrack {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && ["video", "audio", "text_caption"].includes(String(item.type))
    && typeof item.name === "string"
    && typeof item.durationSec === "number"
    && typeof item.clipsCount === "number"
    && typeof item.volumeDb === "number";
}

export class MCPRemoteSyncService {
  private static requestSequence = 0;

  public static async checkConnection(): Promise<MCPConnectionStatus> {
    try {
      const health = await GatewayClient.getHealth();
      return {
        connected: health.teminaliCutMcp.state === "healthy",
        latencyMs: health.teminaliCutMcp.latencyMs || 0,
        detail: health.teminaliCutMcp.detail,
        checkedAt: health.teminaliCutMcp.checkedAt,
      };
    } catch (error) {
      return {
        connected: false,
        latencyMs: 0,
        detail: error instanceof Error ? error.message : "Teminali Cut MCP health check failed.",
        checkedAt: new Date().toISOString(),
      };
    }
  }

  private static async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await GatewayClient.request("/api/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestSequence,
        method,
        params,
      }),
    });
    await GatewayClient.expectOk(response);
    const envelope = (await response.json()) as McpEnvelope<T>;
    if (envelope.error) {
      throw new GatewayError(envelope.error.message || "Teminali Cut MCP returned an error.", envelope.error.code || "MCP_ERROR", 502);
    }
    if (envelope.result === undefined) {
      throw new GatewayError("Teminali Cut MCP returned no result.", "MCP_EMPTY_RESULT", 502);
    }
    return envelope.result;
  }

  public static async splitSilenceAndAlignBpm(
    trackId = "A1",
    thresholdDb = -32,
    bpm = 120,
  ): Promise<MCPSilenceCutResult> {
    const result = await this.call<unknown>("detect_silence_and_split", {
      trackId,
      thresholdDb,
      bpm,
      alignDownbeats: true,
      dryRun: false,
      idempotencyKey: `silence-${trackId}-${Date.now()}`,
    });
    if (!isSilenceResult(result)) {
      throw new GatewayError("Teminali Cut MCP returned an invalid silence-cut result.", "MCP_INVALID_RESULT", 502);
    }
    return result;
  }

  public static async alignCutsToBpm(trackId = "A2", bpm = 120): Promise<MCPSilenceCutResult> {
    const result = await this.call<unknown>("sync_cuts_to_audio_beats", {
      trackId,
      bpm,
      dryRun: false,
      idempotencyKey: `beat-${trackId}-${Date.now()}`,
    });
    if (!isSilenceResult(result)) {
      throw new GatewayError("Teminali Cut MCP returned an invalid beat-sync result.", "MCP_INVALID_RESULT", 502);
    }
    return result;
  }

  public static async getActiveTracks(): Promise<MCPTimelineTrack[]> {
    const result = await this.call<unknown>("get_timeline_state", {});
    const tracks = Array.isArray(result)
      ? result
      : result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).tracks)
        ? (result as { tracks: unknown[] }).tracks
        : null;
    if (!tracks || !tracks.every(isTimelineTrack)) {
      throw new GatewayError("Teminali Cut MCP returned an invalid timeline state.", "MCP_INVALID_TIMELINE", 502);
    }
    return tracks;
  }
}
