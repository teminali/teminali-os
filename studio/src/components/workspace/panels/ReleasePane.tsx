import React, { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, LoaderCircle, RefreshCw, ShieldAlert, Upload } from "lucide-react";
import { PlatformService, type Identity, type ReleaseEvent, type UpdateStatus } from "../../../services/platformService";
import { EmptyState, IconButton } from "../../ui";

/**
 * Cutting a release of the studio, from inside the studio.
 *
 * The loop this closes: the arena is used to develop Teminali here, and this is
 * where the result ships. Verify, build, publish to GitHub — in that order,
 * because a release process exists precisely to stop a build whose tests did
 * not pass from reaching anybody.
 *
 * Two safety properties are deliberate and worth keeping:
 *
 *   1. **Dry run is the default.** Publishing is opt-in per run, not a flag you
 *      forget to unset. The button says which one it is going to do.
 *   2. **The gate is on the server.** This panel is only offered to an
 *      administrator, but `/api/updates/publish` re-checks; hiding a button is
 *      a courtesy, not a control.
 */

/**
 * Render order for the steps a run emits.
 *
 * A dry run stops after `publish` (a local macOS package that is never
 * uploaded). A real publish never runs that step at all — it tags, pushes, and
 * GitHub Actions builds all three platforms — so the two paths share the first
 * three entries and diverge after them. Listing both and filtering to what
 * actually reported keeps one list for two flows.
 */
const STEP_ORDER = ["typecheck", "test", "build", "publish", "preflight", "tag", "ci", "notes"] as const;

export const ReleasePane: React.FC = () => {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Record<string, { label: string; status: string; durationMs?: number; detail?: string | null }>>({});
  const [log, setLog] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [who, status] = await Promise.all([
      PlatformService.me(signal),
      PlatformService.checkForUpdate(signal),
    ]);
    if (signal?.aborted) return;
    setIdentity(who);
    setUpdate(status);
    // Offer the obvious next patch rather than making the operator type it.
    if (status?.version && !version) {
      const parts = status.version.split(".");
      if (parts.length === 3) setVersion(`${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`);
    }
  }, [version]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
    // Refresh is stable enough for mount; re-running it on `version` would
    // fight the operator while they are typing one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const publish = async () => {
    setRunning(true);
    setSteps({});
    setLog([]);
    setFailure(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await PlatformService.publishRelease(
        { version, notes, dryRun },
        (event: ReleaseEvent) => {
          if (event.type === "step") {
            setSteps((current) => ({
              ...current,
              [event.id]: { label: event.label, status: event.status, durationMs: event.durationMs, detail: event.detail },
            }));
          } else if (event.type === "output") {
            // Bounded: a full electron-builder log is tens of thousands of
            // lines and the tail is the part that matters.
            setLog((current) => [...current, event.text].slice(-400));
          } else if (event.type === "error") {
            setFailure(event.message);
          } else if (event.type === "done") {
            setFailure(null);
          }
        },
        controller.signal,
      );
      void refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The release failed to start.");
    } finally {
      setRunning(false);
    }
  };

  if (identity && !identity.isAdmin) {
    return (
      <EmptyState
        title="Administrators only"
        detail={identity.reason ?? "Releases can only be published by an administrator of this studio."}
      />
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-8 flex-shrink-0 flex items-center justify-between pl-3.5 pr-2">
        <span className="text-sm text-ink-faint">Release</span>
        <IconButton onClick={() => void refresh()} title="Re-check GitHub" size={24}>
          <RefreshCw size={13} />
        </IconButton>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 space-y-3">
        {/* ── Where things stand ─────────────────────────────────────────── */}
        <div className="rounded-lg bg-surface-sunken border border-edge px-3 py-2.5 text-2xs space-y-1">
          <div className="flex justify-between gap-2">
            <span className="text-ink-muted">Running</span>
            <span className="text-ink-body font-mono">{update?.version ?? "—"}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-ink-muted">Latest on GitHub</span>
            <span className="text-ink-body font-mono truncate">{update?.latest?.tag ?? "—"}</span>
          </div>
          {/* "We could not check" is not "you are up to date". */}
          {update?.error && <div className="text-warning pt-1">{update.error}</div>}
        </div>

        {/* ── The release ────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <label className="block">
            <span className="block text-2xs text-ink-muted pb-1">New version</span>
            <input
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="1.0.1"
              className="lit w-full h-8 px-2.5 rounded-md bg-surface text-sm text-ink-high font-mono outline-none"
            />
          </label>
          <label className="block">
            <span className="block text-2xs text-ink-muted pb-1">Notes</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              placeholder="What changed in this release"
              className="lit w-full px-2.5 py-2 rounded-md bg-surface text-sm text-ink-high outline-none resize-none"
            />
          </label>

          <label className="flex items-center gap-2 text-2xs text-ink-muted cursor-pointer">
            <input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
            Dry run — build and verify without publishing
          </label>

          <button
            type="button"
            disabled={running || !version.trim()}
            onClick={() => void publish()}
            className={`w-full h-8 rounded-md text-sm flex items-center justify-center gap-2 transition-colors duration-ds ease-ds disabled:opacity-40 ${
              dryRun ? "bg-surface-raised hover:bg-surface-hover text-ink-high" : "bg-action hover:bg-action-hover text-action-ink"
            }`}
          >
            {running ? <LoaderCircle size={13} className="animate-spin" /> : <Upload size={13} />}
            {running ? "Running…" : dryRun ? `Verify and build ${version || ""}` : `Release ${version || ""} from GitHub Actions`}
          </button>

          {!dryRun && (
            <p className="flex items-start gap-1.5 text-2xs text-warning">
              <ShieldAlert size={12} className="flex-shrink-0 mt-0.5" />
              This commits the version bump, pushes a tag, and GitHub Actions builds macOS, Windows and Linux
              from it. Every install will be offered the result. Your working tree must be clean — a release
              ships what is committed.
            </p>
          )}
        </div>

        {/* ── Steps ─────────────────────────────────────────────────────── */}
        {Object.keys(steps).length > 0 && (
          <div className="space-y-1">
            {STEP_ORDER.filter((id) => steps[id]).map((id) => {
              const step = steps[id];
              return (
                <div key={id} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-surface-sunken">
                  {step.status === "running" ? (
                    <LoaderCircle size={12} className="animate-spin text-ink-muted flex-shrink-0" />
                  ) : step.status === "passed" ? (
                    <CircleCheck size={12} className="text-success flex-shrink-0" />
                  ) : (
                    <CircleX size={12} className="text-danger flex-shrink-0" />
                  )}
                  <span className="flex-1 min-w-0 truncate text-2xs text-ink-body">{step.label}</span>
                  {step.durationMs !== undefined && (
                    <span className="text-2xs text-ink-soft tabular-nums">{(step.durationMs / 1000).toFixed(1)}s</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {failure && <p className="text-2xs text-danger leading-relaxed">{failure}</p>}

        {log.length > 0 && (
          <pre
            ref={logRef}
            className="max-h-52 overflow-y-auto rounded-lg bg-surface-sunken border border-edge p-2 font-mono text-3xs text-ink-code whitespace-pre-wrap break-all"
          >
            {log.join("")}
          </pre>
        )}
      </div>
    </div>
  );
};
