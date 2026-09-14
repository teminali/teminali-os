import React, { useCallback, useEffect, useState } from "react";
import { Layers, RefreshCw } from "lucide-react";
import { SettingGroup, SettingRow } from "../ui/Setting";
import { EntitlementSection } from "../workspace/panels/EntitlementSection";
import { resolveGatewayUrl } from "../../services/gatewayClient";
import { useStudioStore } from "../../store/studioStore";
import type { ModelProfileId } from "../../types";

/**
 * Licence & Usage.
 *
 * Cursor's equivalent screen is a metered percentage against a subscription.
 * Ours cannot be, and pretending otherwise would be the same class of lie this
 * whole lane is about: there is no per-request meter to report, because on the
 * local lane the requests are free and on the agent lanes they are billed by
 * somebody else. So the screen answers the questions we can actually answer —
 * what did you buy from us, and what is running on this machine right now.
 *
 * `EntitlementSection` is reused rather than reimplemented. It already reads
 * the plan catalogue from the gateway (which reads `licence/entitlements.js`),
 * already fails to null rather than telling an offline subscriber they are on
 * Free, and is the same component the Usage panel shows. A second copy of that
 * logic on this screen is a second copy to drift.
 *
 * The gateway card moved here from General, where it had been the only thing
 * on an otherwise empty screen. It belongs with the rest of "what is running".
 */

interface LocalModel {
  name: string;
  model: string;
  size: number;
}

interface GatewayHealth {
  url: string;
  state: "healthy" | "degraded" | null;
  ollama: string | null;
  error: string | null;
}

/** Weights are gigabytes or they are nothing; MB precision here is noise. */
const formatBytes = (bytes: number): string => {
  if (!bytes) return "0 B";
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const PROFILE_LABEL: Record<ModelProfileId, string> = {
  flash: "Flash",
  auto: "Auto",
  max: "Max",
};

export const LicencePane: React.FC = () => {
  const currentProfile = useStudioStore((state) => state.currentProfile);
  const agentSelection = useStudioStore((state) => state.agentSelection);
  const setSettingsCategory = useStudioStore((state) => state.setSettingsCategory);

  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [models, setModels] = useState<LocalModel[] | null>(null);

  /* The address is only known at runtime — 4310 is preferred, but a second
     instance or a development gateway holding it moves this app to an
     ephemeral port, and the card used to print 4310 either way. */
  const probe = useCallback(async () => {
    const url = resolveGatewayUrl("/api/health");
    try {
      const response = await fetch(url);
      if (!response.ok) {
        setHealth({ url, state: null, ollama: null, error: `The gateway answered ${response.status}.` });
        return;
      }
      const body = await response.json();
      setHealth({
        url: url.replace(/\/api\/health$/, ""),
        state: body?.state === "healthy" ? "healthy" : "degraded",
        ollama: body?.dependencies?.ollama?.state ?? null,
        error: null,
      });
    } catch {
      setHealth({ url, state: null, ollama: null, error: "The gateway could not be reached." });
    }
  }, []);

  const readWeights = useCallback(async () => {
    try {
      const response = await fetch("/api/models/local");
      if (!response.ok) {
        setModels([]);
        return;
      }
      const body = await response.json();
      setModels(body.connected ? (body.models ?? []) : []);
    } catch {
      setModels([]);
    }
  }, []);

  useEffect(() => {
    void probe();
    void readWeights();
  }, [probe, readWeights]);

  const onDisk = models ?? [];
  const totalBytes = onDisk.reduce((sum, model) => sum + (model.size || 0), 0);
  const activeLane = agentSelection?.label ?? PROFILE_LABEL[currentProfile] ?? currentProfile;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-bright">Licence &amp; Usage</h1>
        <p className="mt-1 text-xs text-ink-muted">
          What this machine is licensed for, and what it is running.
        </p>
      </div>

      <SettingGroup label="Licence">
        <div className="p-3.5">
          <EntitlementSection />
        </div>
      </SettingGroup>

      <SettingGroup
        label="This machine"
        description="Measured now, not remembered. Every figure below comes from a live read."
      >
        <SettingRow
          label="Local gateway"
          description={
            health === null
              ? "Checking…"
              : health.error
                ? health.error
                : `${health.url} · Ollama ${health.ollama ?? "unknown"}`
          }
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setHealth(null);
                void probe();
              }}
              className="rounded-md p-1 text-ink-muted transition-colors duration-ds ease-ds hover:bg-surface-hover hover:text-ink-high"
              aria-label="Re-check the gateway"
              title="Re-check"
            >
              <RefreshCw size={12} />
            </button>
            <span
              className={`rounded-md border px-2 py-1 text-2xs font-medium ${
                health === null
                  ? "border-edge bg-surface-chip text-ink-muted"
                  : health.state === "healthy"
                    ? "border-success/25 bg-success/10 text-success"
                    : health.state === "degraded"
                      ? "border-warning/25 bg-warning/10 text-warning"
                      : "border-danger/25 bg-danger/10 text-danger"
              }`}
            >
              {health === null
                ? "Checking"
                : health.state === "healthy"
                  ? "Connected"
                  : health.state === "degraded"
                    ? "Degraded"
                    : "Unreachable"}
            </span>
          </div>
        </SettingRow>

        <SettingRow
          label="Active lane"
          description="Which engine the next prompt goes to. Change it from the composer, where the choice is in front of the prompt it applies to."
        >
          <span className="rounded-md border border-edge bg-surface-chip px-2 py-1 text-2xs font-medium text-ink-body">
            {activeLane}
          </span>
        </SettingRow>

        <SettingRow
          label="Model weights on disk"
          description={
            models === null
              ? "Reading…"
              : onDisk.length === 0
                ? "No local weights found. The local lane needs at least one model pulled before it can answer."
                : `${onDisk.length} model${onDisk.length === 1 ? "" : "s"}, ${formatBytes(totalBytes)} total.`
          }
        >
          <button
            type="button"
            onClick={() => setSettingsCategory("models")}
            className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-2xs font-semibold text-accent-ink transition-colors duration-ds ease-ds hover:bg-accent-hover"
          >
            <Layers size={12} />
            Manage
          </button>
        </SettingRow>
      </SettingGroup>
    </div>
  );
};

/** The row labels this pane carries, for the settings rail's search. */
export const LICENCE_ROWS = ["Licence", "Local gateway", "Active lane", "Model weights on disk"];
