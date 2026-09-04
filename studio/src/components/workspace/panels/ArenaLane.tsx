import React, { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
} from "lucide-react";
import { describeCall } from "../../../services/activityGroups";
import { formatElapsed, isLaneBusy, statusLabel, tailOf } from "../../../services/arenaLive";
import type { LiveCheck, LaneStatus } from "../../../services/arenaLive";
import type { Contestant, SandboxInfo, SandboxMeasurement, Verdict } from "../../../services/arenaService";
import { BrandGlyph } from "../../ui";
import type { ToolCall } from "../../../types";

/**
 * One contestant, watched live.
 *
 * This is the surface the benchmark exists for: while an agent is working you
 * can see the text it is producing, the tool it is running *right now*, and —
 * once it stops — the checks going green or red one at a time. A benchmark you
 * can only read after it finishes is a report; this is an instrument.
 *
 * Everything here is observed rather than announced. The tool rows come from
 * the agent's own event stream, the check rows from the process exit codes in
 * its sandbox, and the file counts from `git diff` — so a lane that says an
 * agent changed nothing is a lane where the agent changed nothing.
 */

export interface Lane {
  contestant: Contestant;
  status: LaneStatus;
  sandbox: SandboxInfo | null;
  /** Everything the agent has said so far, appended as it streams. */
  text: string;
  tools: ToolCall[];
  tokens: number;
  costUsd: number | null;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  checks: LiveCheck[];
  measurement: SandboxMeasurement | null;
}

export const ArenaLane: React.FC<{
  lane: Lane;
  /** Ticks while the run is live, so the clock moves without a timer per lane. */
  now: number;
  score?: Verdict["scores"][string];
  isWinner?: boolean;
}> = ({ lane, now, score, isWinner }) => {
  const [showTools, setShowTools] = useState(false);
  const busy = isLaneBusy(lane.status);
  const elapsed = lane.startedAt === null ? 0 : (lane.endedAt ?? now) - lane.startedAt;
  const running = lane.tools.filter((call) => call.status === "running");
  const measurement = lane.measurement;

  return (
    <div className="rounded-lg bg-surface-sunken border border-edge p-2.5 space-y-2">
      {/* ── Who, and how long ──────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <BrandGlyph brand={lane.contestant.kind === "frontier" ? "teminali" : lane.contestant.kind} size={14} />
        <span className="text-sm text-ink-body truncate">{lane.contestant.label}</span>
        {isWinner && <span className="text-3xs px-1.5 py-0.5 rounded-full bg-action text-action-ink flex-shrink-0">winner</span>}
        <span className="flex-1" />
        <span className="text-2xs text-ink-soft tabular-nums flex-shrink-0">{formatElapsed(elapsed)}</span>
      </div>

      {/* ── What it is doing this second ───────────────────────────────── */}
      <div className="flex items-center gap-1.5 min-w-0">
        <StatusDot status={lane.status} />
        <span className={`text-2xs flex-shrink-0 ${lane.status === "failed" ? "text-danger" : "text-ink-muted"}`}>
          {statusLabel(lane.status)}
        </span>
        {running.length > 0 && (
          <>
            <span className="text-ink-disabled text-2xs flex-shrink-0">·</span>
            <span className="font-mono text-3xs text-ink-soft truncate min-w-0">{describeCall(running[0])}</span>
          </>
        )}
      </div>

      {/* ── The transcript, following along ────────────────────────────── */}
      {(lane.text || busy) && <StreamBox text={lane.text} live={busy} height={busy ? 132 : 92} />}

      {/* ── Every tool call, as it happens ─────────────────────────────── */}
      {lane.tools.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowTools((open) => !open)}
            className="w-full flex items-center gap-1 text-2xs text-ink-muted hover:text-ink-high transition-colors duration-ds ease-ds"
          >
            {showTools ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {lane.tools.length} tool {lane.tools.length === 1 ? "call" : "calls"}
            <span className="flex-1" />
            <span className="text-3xs text-ink-disabled tabular-nums">
              {lane.tools.filter((call) => call.status === "completed").length} done
            </span>
          </button>
          {showTools && (
            <ol className="mt-1 max-h-40 overflow-y-auto space-y-0.5">
              {lane.tools.map((call, index) => (
                <li key={call.id ?? index} className="flex items-center gap-1.5 min-w-0">
                  {call.status === "running" ? (
                    <LoaderCircle size={10} className="text-ink-muted animate-spin flex-shrink-0" />
                  ) : call.status === "error" ? (
                    <CircleX size={10} className="text-danger flex-shrink-0" />
                  ) : (
                    <CircleCheck size={10} className="text-success flex-shrink-0" />
                  )}
                  <span className="text-3xs text-ink-muted flex-shrink-0">{call.name}</span>
                  <span className="font-mono text-3xs text-ink-soft truncate min-w-0">{describeCall(call)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {/* ── Verification, one check at a time ──────────────────────────── */}
      {lane.checks.map((check) => (
        <CheckRow key={check.name} check={check} />
      ))}

      {/* ── What it changed, measured from disk ────────────────────────── */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-2xs pt-0.5">
        <Stat label="Files changed" value={measurement ? String(measurement.filesChanged) : "—"} />
        <Stat
          label="Lines"
          value={measurement ? `+${measurement.linesAdded} / -${measurement.linesRemoved}` : "—"}
        />
        <Stat label="Tool calls" value={String(lane.tools.length)} />
        <Stat label="Tokens" value={lane.tokens ? lane.tokens.toLocaleString() : "—"} />
        {/* An agent that reports no cost is not an agent that cost nothing. */}
        <Stat label="Cost" value={lane.costUsd !== null ? `$${lane.costUsd.toFixed(4)}` : "not reported"} />
      </div>

      {lane.error && <p className="text-2xs text-danger leading-relaxed">{lane.error}</p>}

      {/* ── The watcher's scores, once there are any ───────────────────── */}
      {score && (
        <div className="pt-1 border-t border-edge space-y-0.5">
          {(["correctness", "scope", "readability", "regressions"] as const).map((key) => {
            const value = score[key];
            if (typeof value !== "number") return null;
            return (
              <div key={key} className="flex items-center gap-2 text-2xs">
                <span className="text-ink-muted capitalize w-20 flex-shrink-0">{key}</span>
                <div className="flex-1 h-1 rounded-full bg-chart-track overflow-hidden">
                  <div className="h-full rounded-full bg-chart" style={{ width: `${(value / 5) * 100}%` }} />
                </div>
                <span className="text-ink-soft tabular-nums">{value}/5</span>
              </div>
            );
          })}
          {score.evidence && <p className="text-3xs text-ink-soft leading-relaxed pt-0.5">{score.evidence}</p>}
        </div>
      )}
    </div>
  );
};

/* ── Pieces ───────────────────────────────────────────────────────────────── */

/**
 * A transcript box that follows the stream — until you scroll up.
 *
 * Yanking someone back to the bottom while they are reading an earlier line is
 * the standard way live output becomes unreadable, so scrolling away detaches
 * and scrolling back to the end re-attaches.
 */
export const StreamBox: React.FC<{ text: string; live: boolean; height: number }> = ({ text, live, height }) => {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const node = ref.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [text]);

  return (
    <div
      ref={ref}
      onScroll={(event) => {
        const node = event.currentTarget;
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}
      style={{ height }}
      className="overflow-y-auto rounded-md bg-surface px-2 py-1.5 font-mono text-3xs leading-relaxed text-ink-code whitespace-pre-wrap break-words"
    >
      {tailOf(text) || (live ? <span className="text-ink-disabled">waiting for the first token…</span> : null)}
      {live && text && <span className="inline-block w-1 h-3 -mb-0.5 ml-0.5 bg-ink-muted animate-pulse" />}
    </div>
  );
};

const StatusDot: React.FC<{ status: LaneStatus }> = ({ status }) => {
  if (status === "failed") return <CircleX size={11} className="text-danger flex-shrink-0" />;
  if (status === "done") return <CircleCheck size={11} className="text-success flex-shrink-0" />;
  if (status === "stopped") return <CircleDashed size={11} className="text-ink-disabled flex-shrink-0" />;
  if (status === "queued") return <CircleDashed size={11} className="text-ink-disabled flex-shrink-0" />;
  return <LoaderCircle size={11} className="text-ink-muted animate-spin flex-shrink-0" />;
};

const CheckRow: React.FC<{ check: LiveCheck }> = ({ check }) => {
  const [open, setOpen] = useState(false);
  const failed = check.state === "failed";

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!check.output}
        className="w-full flex items-center gap-1.5 text-2xs text-left disabled:cursor-default"
      >
        {check.state === "running" ? (
          <LoaderCircle size={11} className="text-ink-muted animate-spin flex-shrink-0" />
        ) : check.state === "pending" ? (
          <CircleDashed size={11} className="text-ink-disabled flex-shrink-0" />
        ) : failed ? (
          <CircleX size={11} className="text-danger flex-shrink-0" />
        ) : (
          <CircleCheck size={11} className="text-success flex-shrink-0" />
        )}
        <span className={failed ? "text-danger" : "text-ink-muted"}>{check.name}</span>
        <span className="flex-1" />
        <span className="text-3xs text-ink-disabled tabular-nums">
          {check.state === "pending" ? "not run yet" : check.state === "running" ? "running" : formatElapsed(check.durationMs)}
        </span>
      </button>
      {/* A failing check is only useful with the output that explains it. */}
      {open && check.output && (
        <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-surface px-2 py-1.5 font-mono text-3xs text-ink-code whitespace-pre-wrap">
          {check.output}
        </pre>
      )}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex justify-between gap-2 min-w-0">
    <span className="text-ink-muted truncate">{label}</span>
    <span className="text-ink-body tabular-nums flex-shrink-0">{value}</span>
  </div>
);
