import { useEffect, useState } from "react";
import type { InferenceTelemetry, RuntimeHealthReport } from "../types";
import { GatewayClient } from "../services/gatewayClient";
import { RuntimeTelemetryService } from "../services/runtimeTelemetryService";

const CHECKING_HEALTH: RuntimeHealthReport = {
  state: "checking",
  gateway: { state: "checking", latencyMs: null, detail: "Checking gateway", checkedAt: new Date(0).toISOString() },
  ollama: { state: "checking", latencyMs: null, detail: "Checking Ollama", checkedAt: new Date(0).toISOString() },
  teminaliCutMcp: { state: "checking", latencyMs: null, detail: "Checking Teminali Cut MCP", checkedAt: new Date(0).toISOString() },
  models: [],
};

const OFFLINE_HEALTH: RuntimeHealthReport = {
  state: "offline",
  gateway: { state: "offline", latencyMs: null, detail: "Gateway offline", checkedAt: new Date(0).toISOString() },
  ollama: { state: "offline", latencyMs: null, detail: "Not checked", checkedAt: new Date(0).toISOString() },
  teminaliCutMcp: { state: "offline", latencyMs: null, detail: "Not checked", checkedAt: new Date(0).toISOString() },
  models: [],
};

export function useRuntimeTelemetry(pollMs = 5000): {
  health: RuntimeHealthReport;
  telemetry: InferenceTelemetry | null;
} {
  const [health, setHealth] = useState<RuntimeHealthReport>(CHECKING_HEALTH);
  const [telemetry, setTelemetry] = useState<InferenceTelemetry | null>(RuntimeTelemetryService.getLatest());

  useEffect(() => RuntimeTelemetryService.subscribe(setTelemetry), []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const report = await GatewayClient.getHealth();
        if (!cancelled) setHealth(report);
      } catch {
        if (!cancelled) setHealth({
          ...OFFLINE_HEALTH,
          gateway: { ...OFFLINE_HEALTH.gateway, checkedAt: new Date().toISOString() },
        });
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [pollMs]);

  return { health, telemetry };
}
