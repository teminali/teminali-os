import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CircleAlert, Info, PowerOff, RefreshCw } from "lucide-react";
import { Chip, EmptyState, IconButton, SectionLabel, StatusDot } from "../ui";
import type { GovernorReport } from "../../services/guardianService";
import {
  GuardianService,
  formatBytes,
  formatDuration,
  formatPercent,
  type GuardianAdvice,
  type GuardianSnapshot,
  type ProcessGroup,
} from "../../services/guardianService";

/**
 * Guardian — the machine, in one column.
 *
 * The question this answers is "what is resident right now, and what is
 * competing with it", so resident models come first and everything else is
 * context for them. It is deliberately dense: a telemetry panel that needs
 * scrolling to reach the number you opened it for has failed, so there are no
 * hero figures, no dials, and no card per metric — just aligned rows in the
 * mono face, which is the only way a column of numbers stays readable.
 *
 * Nothing here fills a gap. A metric the server could not measure arrives as
 * null and renders as an em dash, with the reason available at the foot of the
 * panel; the alternative — a plausible zero — is worse than no reading at all.
 */

const POLL_INTERVAL_MS = 3000;

export const GuardianPanel: React.FC = () => {
  const [snapshot, setSnapshot] = useState<GuardianSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [processOrder, setProcessOrder] = useState<"memory" | "cpu">("memory");
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [governor, setGovernor] = useState<GovernorReport | null>(null);
  const [closing, setClosing] = useState(false);

  // A poll that outlives the panel would keep shelling out to ps forever.
  const mounted = useRef(true);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await GuardianService.snapshot(signal);
      if (!mounted.current) return;
      setSnapshot(next);
      setError(null);
      // Enumerating open apps shells out per app, so a failure here must not
      // take the snapshot down with it — the rest of the panel still works.
      try {
        const report = await GuardianService.governor(signal);
        if (mounted.current) setGovernor(report);
      } catch {
        if (mounted.current) setGovernor(null);
      }
    } catch (failure) {
      if (!mounted.current || signal?.aborted) return;
      setError((failure as Error).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const unload = useCallback(
    async (model: string) => {
      setBusyModel(model);
      setNotice(null);
      try {
        const result = await GuardianService.unload(model);
        // Report what the server confirmed against /api/ps, not what we asked for.
        setNotice(
          result.unloaded
            ? `Unloaded ${model} — freed ${formatBytes(result.freedBytes)}.`
            : (result.detail ?? `${model} is still resident.`),
        );
        await refresh();
      } catch (failure) {
        setNotice((failure as Error).message);
      } finally {
        if (mounted.current) setBusyModel(null);
      }
    },
    [refresh],
  );

  if (!snapshot) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <PanelHeader snapshot={null} onRefresh={() => void refresh()} />
        <EmptyState
          icon={<RefreshCw size={26} strokeWidth={1.6} />}
          title={error ? "Guardian is not reporting" : "Reading the machine…"}
          detail={error ?? "Sampling CPU, memory and Ollama residency."}
          {...(error ? { action: { label: "Retry", onClick: () => void refresh() } } : {})}
        />
      </div>
    );
  }

  const { memory, swap, ollama, processes, power, thermal, disk, cpu } = snapshot;
  const rows = processOrder === "memory" ? processes.byMemory : processes.byCpu;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader snapshot={snapshot} error={error} onRefresh={() => void refresh()} />

      <div className="flex-1 min-h-0 overflow-y-auto py-3 flex flex-col gap-4">
        {/* ── Machine pressure ───────────────────────────────────────────────
            This backend was built and tested but nothing had ever called it.
            Guardian reports and proposes; it closes nothing until asked. */}
        {governor?.supported && governor.plan.selected.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <SectionLabel
              trailing={
                <span className="font-mono text-2xs text-ink-muted">
                  {formatBytes(governor.plan.reclaimableBytes)} reclaimable
                </span>
              }
            >
              Memory pressure
            </SectionLabel>

            <ul className="px-2 flex flex-col gap-1">
              {governor.plan.selected.map((app) => (
                <li key={app.name} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-hover">
                  <span className="flex-1 min-w-0 truncate text-xs text-ink-body">{app.name}</span>
                  <span className="text-2xs text-ink-soft truncate max-w-[150px]" title={app.reason}>
                    {app.reason}
                  </span>
                  {app.rssBytes !== null && (
                    <span className="font-mono text-2xs text-ink-muted">{formatBytes(app.rssBytes)}</span>
                  )}
                </li>
              ))}
            </ul>

            <div className="px-4">
              <button
                type="button"
                // The gateway refuses to close anything while the governor is
                // off, so a live-looking button here would always 409. Off is
                // also the shipped default.
                disabled={closing || !governor.settings.enabled}
                title={governor.settings.enabled ? undefined : "Turn the app governor on in Guardian settings first"}
                onClick={async () => {
                  setClosing(true);
                  try {
                    const result = await GuardianService.enforce(governor.plan.selected.map((app) => app.name));
                    const failed = result.results.filter((entry) => !entry.ok);
                    setNotice(
                      failed.length === 0
                        ? `Closed ${result.results.length} app${result.results.length === 1 ? "" : "s"}.`
                        : `${failed.length} could not be closed: ${failed.map((entry) => entry.name).join(", ")}`,
                    );
                    void refresh();
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : "Could not close those apps.");
                  } finally {
                    setClosing(false);
                  }
                }}
                className="h-7 px-3 rounded-md bg-surface-raised hover:bg-surface-hover text-xs text-ink-high disabled:opacity-40 transition-colors duration-ds ease-ds"
              >
                {closing ? "Closing…" : `Close ${governor.plan.selected.length}`}
              </button>
              {/* Anything with unsaved work is never in the plan. Saying so is
                  what makes the button safe to press without reading first. */}
              <span className="ml-2 text-2xs text-ink-soft">
                {governor.settings.enabled
                  ? "apps with unsaved work are never included"
                  : "the app governor is switched off"}
              </span>
            </div>
          </section>
        )}

        {/* ── Resident models ────────────────────────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionLabel
            trailing={
              ollama.reachable && ollama.residentModels.length > 0 ? (
                <span className="font-mono text-2xs text-ink-muted">{formatBytes(ollama.totalVramBytes)} wired</span>
              ) : undefined
            }
          >
            Resident models
          </SectionLabel>

          {!ollama.reachable ? (
            <Notice tone="danger">{ollama.error ?? "Ollama is not reachable."}</Notice>
          ) : ollama.residentModels.length === 0 ? (
            <p className="px-4 text-xs text-ink-faint">
              Nothing is resident. The next request pays a cold load from disk.
            </p>
          ) : (
            <ul className="px-2 flex flex-col gap-1">
              {ollama.residentModels.map((model) => (
                <li
                  key={model.name}
                  className="lit lit-inner rounded-lg bg-surface px-2.5 py-2 flex items-start gap-2"
                >
                  <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <StatusDot tone="success" pulse={model.idleSeconds < 10} />
                      <span className="font-mono text-xs text-ink-bright truncate">{model.name}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Chip>{formatBytes(model.vramBytes)}</Chip>
                      {model.parameterSize && <Chip>{model.parameterSize}</Chip>}
                      {model.quantization && <Chip>{model.quantization}</Chip>}
                      {model.contextLength && <Chip>{(model.contextLength / 1024).toFixed(0)}k ctx</Chip>}
                      {/* An idle figure we have not yet proven gets a "≥", because
                          we only know the model was untouched since we started looking. */}
                      <Chip>
                        idle {model.idleIsLowerBound ? "≥" : ""}
                        {formatDuration(model.idleSeconds)}
                      </Chip>
                      {model.expiresInSeconds !== null && (
                        <Chip>auto-unload {formatDuration(model.expiresInSeconds)}</Chip>
                      )}
                    </div>
                  </div>
                  <IconButton
                    size={24}
                    disabled={busyModel === model.name}
                    onClick={() => void unload(model.name)}
                    title={`Unload ${model.name} and free ${formatBytes(model.vramBytes)}`}
                    aria-label={`Unload ${model.name}`}
                  >
                    <PowerOff size={13} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}

          {notice && <p className="px-4 font-mono text-2xs text-ink-muted">{notice}</p>}
        </section>

        {/* ── Machine ────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionLabel
            trailing={
              memory.pressure ? (
                <span className="flex items-center gap-1.5 font-mono text-2xs text-ink-muted">
                  <StatusDot tone={pressureTone(memory.pressure)} />
                  {memory.pressure} pressure
                </span>
              ) : undefined
            }
          >
            Machine
          </SectionLabel>

          <div className="px-4 flex flex-col gap-1">
            <Metric
              label="Memory"
              value={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}
              percent={memory.usedPercent}
              tone={memory.pressure === "critical" ? "danger" : memory.pressure === "warning" ? "warning" : "accent"}
              note={memory.availableBytes !== null ? `${formatBytes(memory.availableBytes)} available` : null}
            />
            <Metric
              label="Swap"
              value={swap ? `${formatBytes(swap.usedBytes)} / ${formatBytes(swap.totalBytes)}` : "—"}
              percent={swap?.usedPercent ?? null}
              // Any swap at all is worth colouring: it is the signal that the
              // machine has already run out once.
              tone={(swap?.usedBytes ?? 0) > 0 ? "warning" : "accent"}
            />
            <Metric
              label="CPU"
              value={formatPercent(cpu.percent)}
              percent={cpu.percent}
              tone="accent"
              note={`${cpu.cores} cores · load ${snapshot.load.map((entry) => entry.toFixed(2)).join(" ")}`}
            />
            <Metric
              label="Disk"
              value={disk ? `${formatBytes(disk.freeBytes)} free` : "—"}
              percent={disk?.usedPercent ?? null}
              tone={(disk?.usedPercent ?? 0) > 90 ? "warning" : "accent"}
            />
            <Row label="Power" value={powerSummary(snapshot)} />
            <Row
              label="Thermal"
              value={
                thermal?.recorded
                  ? `CPU limit ${formatPercent(thermal.cpuSpeedLimitPercent)}`
                  : "no limit recorded"
              }
            />
            <Row label="Uptime" value={formatDuration(snapshot.host.uptimeSeconds)} />
          </div>
        </section>

        {/* ── Competing processes ────────────────────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionLabel
            trailing={
              <div className="flex items-center gap-1">
                {(["memory", "cpu"] as const).map((order) => (
                  <Chip
                    key={order}
                    as="button"
                    active={processOrder === order}
                    onClick={() => setProcessOrder(order)}
                  >
                    {order === "memory" ? "MEM" : "CPU"}
                  </Chip>
                ))}
              </div>
            }
          >
            Competing
          </SectionLabel>

          {rows.length === 0 ? (
            <p className="px-4 text-xs text-ink-faint">Process list unavailable.</p>
          ) : (
            <ul className="px-4 flex flex-col gap-1">
              {rows.map((group) => (
                <ProcessRow key={group.name} group={group} order={processOrder} cores={cpu.cores} />
              ))}
            </ul>
          )}
        </section>

        {/* ── Observations ───────────────────────────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionLabel>Observations</SectionLabel>
          <ul className="px-2 flex flex-col gap-1">
            {snapshot.advice.map((entry) => (
              <AdviceRow key={entry.id} advice={entry} busy={busyModel !== null} onUnload={unload} />
            ))}
          </ul>
        </section>

        {/* ── What we could not measure ──────────────────────────────────── */}
        {snapshot.unavailable.length > 0 && (
          <section className="px-4 pb-1">
            <button
              type="button"
              onClick={() => setShowUnavailable((previous) => !previous)}
              className="font-mono text-2xs text-ink-placeholder hover:text-ink-muted transition-colors duration-ds ease-ds"
            >
              {snapshot.unavailable.length} metric{snapshot.unavailable.length === 1 ? "" : "s"} unavailable
              {showUnavailable ? " ▴" : " ▾"}
            </button>
            {showUnavailable && (
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {snapshot.unavailable.map((entry) => (
                  <li key={entry.metric} className="text-2xs text-ink-faint">
                    <span className="font-mono text-ink-placeholder">{entry.metric}</span> — {entry.reason}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
};

/* ── Header ───────────────────────────────────────────────────────────────── */

const PanelHeader: React.FC<{
  snapshot: GuardianSnapshot | null;
  error?: string | null;
  onRefresh: () => void;
}> = ({ snapshot, error, onRefresh }) => (
  <div className="h-11 flex-shrink-0 flex items-center gap-2 px-3 border-b border-edge-chrome">
    <StatusDot tone={error ? "danger" : snapshot ? "success" : "muted"} pulse={!snapshot && !error} />
    <span className="text-sm text-ink-high">Guardian</span>
    <span className="font-mono text-2xs text-ink-placeholder truncate">
      {snapshot ? snapshot.host.hostname.replace(/\.local$/, "") : "connecting"}
    </span>
    <div className="flex-1" />
    {snapshot && (
      <span className="font-mono text-2xs text-ink-placeholder">
        {new Date(snapshot.capturedAt).toLocaleTimeString([], { hour12: false })}
      </span>
    )}
    <IconButton size={24} onClick={onRefresh} title="Sample now">
      <RefreshCw size={13} />
    </IconButton>
  </div>
);

/* ── Rows ─────────────────────────────────────────────────────────────────── */

/**
 * A labelled figure with a hairline bar. The bar is the only graphic in the
 * panel because a percentage is the one thing the eye reads faster as a length
 * than as digits; everything else stays as text.
 */
const Metric: React.FC<{
  label: string;
  value: string;
  percent: number | null;
  tone: "accent" | "warning" | "danger";
  note?: string | null;
}> = ({ label, value, percent, tone, note }) => {
  const fill = { accent: "bg-accent", warning: "bg-warning", danger: "bg-danger" }[tone];
  return (
    <div className="flex flex-col gap-1 py-0.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-ink-muted w-14 flex-shrink-0">{label}</span>
        <span className="font-mono text-xs text-ink-prose">{value}</span>
        <div className="flex-1" />
        <span className="font-mono text-2xs text-ink-faint">{formatPercent(percent)}</span>
      </div>
      <div className="h-[3px] rounded-full bg-surface-sunken overflow-hidden">
        <div
          className={`h-full rounded-full ${fill} transition-[width] duration-slow ease-ds`}
          // A missing reading is a bar of zero width, never a full one.
          style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
        />
      </div>
      {note && <span className="font-mono text-3xs text-ink-placeholder">{note}</span>}
    </div>
  );
};

/** A figure with no percentage behind it, so no bar. */
const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-baseline gap-2 py-0.5">
    <span className="text-xs text-ink-muted w-14 flex-shrink-0">{label}</span>
    <span className="font-mono text-xs text-ink-prose truncate">{value}</span>
  </div>
);

const ProcessRow: React.FC<{ group: ProcessGroup; order: "memory" | "cpu"; cores: number }> = ({
  group,
  order,
  cores,
}) => {
  // %CPU from ps is per-core, so a 12-core machine tops out near 1200%.
  const share =
    order === "memory" ? (group.memoryPercent ?? 0) : Math.min(100, group.cpuPercent / Math.max(1, cores));
  return (
    <li className="flex items-center gap-2">
      <span className="text-xs text-ink-prose truncate flex-1 min-w-0" title={`pid ${group.pid}`}>
        {group.name}
        {group.processCount > 1 && <span className="text-ink-placeholder"> ×{group.processCount}</span>}
      </span>
      <div className="w-16 h-[3px] rounded-full bg-surface-sunken overflow-hidden flex-shrink-0">
        <div className="h-full rounded-full bg-ink-disabled" style={{ width: `${Math.min(100, share)}%` }} />
      </div>
      <span className="font-mono text-2xs text-ink-muted w-14 text-right flex-shrink-0">
        {order === "memory" ? formatBytes(group.rssBytes) : `${group.cpuPercent.toFixed(0)}%`}
      </span>
    </li>
  );
};

const AdviceRow: React.FC<{
  advice: GuardianAdvice;
  busy: boolean;
  onUnload: (model: string) => void | Promise<void>;
}> = ({ advice, busy, onUnload }) => {
  const Icon = advice.severity === "critical" ? CircleAlert : advice.severity === "warning" ? AlertTriangle : Info;
  const tint =
    advice.severity === "critical" ? "text-danger" : advice.severity === "warning" ? "text-warning" : "text-ink-muted";
  return (
    <li className="rounded-lg bg-surface-sunken px-2.5 py-2 flex gap-2">
      <Icon size={13} className={`${tint} flex-shrink-0 mt-0.5`} strokeWidth={2} />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <span className="text-xs text-ink-prose">{advice.title}</span>
        <span className="text-2xs text-ink-faint">{advice.detail}</span>
        {/* The evidence is the point: the operator can reject the conclusion
            and still trust the measurement it was drawn from. */}
        <ul className="flex flex-col gap-0.5">
          {advice.evidence.map((line) => (
            <li key={line} className="font-mono text-3xs text-ink-placeholder">
              {line}
            </li>
          ))}
        </ul>
        {advice.action?.kind === "unload" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void onUnload(advice.action!.model)}
            className="self-start mt-0.5 h-6 px-2.5 rounded-md bg-accent text-frame-top font-mono text-2xs hover:bg-accent-hover disabled:opacity-40 transition-colors duration-ds ease-ds"
          >
            Unload
          </button>
        )}
      </div>
    </li>
  );
};

const Notice: React.FC<{ tone: "danger"; children: React.ReactNode }> = ({ children }) => (
  <p className="px-4 text-xs text-danger">{children}</p>
);

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function pressureTone(pressure: "normal" | "warning" | "critical"): "success" | "warning" | "danger" {
  if (pressure === "critical") return "danger";
  if (pressure === "warning") return "warning";
  return "success";
}

function powerSummary(snapshot: GuardianSnapshot): string {
  const { power } = snapshot;
  if (!power.source) return "—";
  const parts = [power.source];
  if (power.percent !== null) parts.push(`${power.percent}%`);
  if (power.state) parts.push(power.state);
  if (power.minutesRemaining) parts.push(`${formatDuration(power.minutesRemaining * 60)} left`);
  return parts.join(" · ");
}
