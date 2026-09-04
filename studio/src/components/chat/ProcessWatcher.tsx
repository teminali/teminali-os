import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, FileDiff, Globe, Loader2, Search, Terminal, Waypoints, Wrench } from "lucide-react";
import { groupActivity, describeCall, type ActivityGroup, type ActivityKind } from "../../services/activityGroups";
import type { ToolCall } from "../../types";

/**
 * The process inspector: what the turn is doing, while it does it.
 *
 * Three rules, and they are what separate this from a log:
 *
 * 1. **One line per thing that happened, not per event.** Consecutive calls of
 *    a kind collapse — "Ran 6 commands" — and open when asked. A turn that
 *    touched twelve files is three lines tall, not twelve.
 * 2. **A single call never gets a group row.** "Ran ls -la" followed by an
 *    indented "ls -la" is the same sentence twice.
 * 3. **Everything is one weight of grey.** Status is carried by a 10px glyph
 *    and by tense; nothing in here is allowed to compete with the reply itself,
 *    which is the thing the operator is actually reading.
 */

const GLYPHS: Record<ActivityKind, React.ReactNode> = {
  run: <Terminal size={11} />,
  edit: <FileDiff size={11} />,
  explore: <Search size={11} />,
  web: <Globe size={11} />,
  task: <Waypoints size={11} />,
  other: <Wrench size={11} />,
};

export interface ProcessWatcherProps {
  engine?: string;
  mode?: string;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  charCount?: number;
  tokensCount?: number;
  durationSec?: number;
  onJumpToFile?: (path: string, code: string) => void;
  compact?: boolean;
}

export const ProcessWatcher: React.FC<ProcessWatcherProps> = ({
  toolCalls = [],
  isStreaming = false,
  durationSec,
  onJumpToFile,
}) => {
  // Open while the work is happening, closed once it is finished: live, it is
  // the only thing to look at; afterwards it is a footnote under the answer.
  const [expanded, setExpanded] = useState(isStreaming);
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) setExpanded(false);
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

  const groups = useMemo(() => groupActivity(toolCalls), [toolCalls]);
  const elapsed = useElapsed(isStreaming);

  if (!isStreaming && groups.length === 0) return null;

  const steps = toolCalls.length;
  const failed = toolCalls.some((call) => call.status === "error");

  return (
    <div className="select-none">
      <button
        type="button"
        onClick={() => setExpanded((previous) => !previous)}
        aria-expanded={expanded}
        className="group h-6 flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink-dim transition-colors duration-ds ease-ds"
      >
        <ChevronRight
          size={11}
          className={`text-ink-disabled transition-transform duration-ds ease-ds ${expanded ? "rotate-90" : ""}`}
        />
        {isStreaming ? (
          <>
            <Loader2 size={11} className="animate-spin text-ink-faint" />
            <span className="text-shimmer">Working</span>
          </>
        ) : (
          <span>
            {failed ? "Finished with errors" : "Thought"}
            {durationSec ? ` for ${durationSec.toFixed(1)}s` : ""}
          </span>
        )}
        {steps > 0 && (
          <span className="font-mono text-2xs text-ink-disabled tabular-nums">
            · {steps} {steps === 1 ? "step" : "steps"}
          </span>
        )}
        {isStreaming && elapsed >= 1 && (
          <span className="font-mono text-2xs text-ink-disabled tabular-nums">· {formatElapsed(elapsed)}</span>
        )}
      </button>

      {expanded && groups.length > 0 && (
        <ol className="ml-[5px] pl-3 border-l border-edge/70 flex flex-col animate-reveal" role="list">
          {groups.map((group) => (
            <GroupRow key={group.id} group={group} onJumpToFile={onJumpToFile} />
          ))}
        </ol>
      )}
    </div>
  );
};

/** A run of same-kind calls. One call collapses to its own row — rule 2. */
const GroupRow: React.FC<{ group: ActivityGroup; onJumpToFile?: (path: string, code: string) => void }> = ({
  group,
  onJumpToFile,
}) => {
  const [open, setOpen] = useState(false);
  if (group.calls.length === 1) return <CallRow call={group.calls[0]} kind={group.kind} onJumpToFile={onJumpToFile} />;

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className="group w-full h-6 flex items-center gap-1.5 text-left rounded-[5px] px-1 -mx-1 hover:bg-surface-hover/70 transition-colors duration-ds ease-ds"
      >
        <StatusGlyph status={group.status} kind={group.kind} />
        <span className="text-xs text-ink-muted truncate">{group.label}</span>
        {(group.additions > 0 || group.deletions > 0) && <DiffStat additions={group.additions} deletions={group.deletions} />}
        <span className="flex-1" />
        <ChevronRight
          size={10}
          className={`text-ink-disabled opacity-0 group-hover:opacity-100 transition-all duration-ds ease-ds ${open ? "rotate-90 opacity-100" : ""}`}
        />
      </button>
      {open && (
        <ol className="ml-[5px] pl-3 border-l border-edge/50 flex flex-col animate-reveal" role="list">
          {group.calls.map((call, index) => (
            <CallRow key={call.id ?? index} call={call} kind={group.kind} onJumpToFile={onJumpToFile} nested />
          ))}
        </ol>
      )}
    </li>
  );
};

/** One call. Opens to its arguments, its output and its diff — nothing else. */
const CallRow: React.FC<{
  call: ToolCall;
  kind: ActivityKind;
  nested?: boolean;
  onJumpToFile?: (path: string, code: string) => void;
}> = ({ call, kind, nested = false, onJumpToFile }) => {
  const [open, setOpen] = useState(false);
  const failed = call.status === "error";
  const detail = describeCall(call);
  const payload = Object.keys(call.arguments ?? {}).length > 0 || call.result || call.diff?.diffText;

  return (
    <li>
      <button
        type="button"
        onClick={() => payload && setOpen((previous) => !previous)}
        aria-expanded={payload ? open : undefined}
        className="group w-full h-6 flex items-center gap-1.5 text-left rounded-[5px] px-1 -mx-1 hover:bg-surface-hover/70 transition-colors duration-ds ease-ds"
      >
        <StatusGlyph status={call.status === "running" ? "running" : failed ? "error" : "done"} kind={kind} />
        <span
          className={`font-mono text-2xs truncate ${
            failed ? "text-danger/90" : call.status === "running" ? "text-ink-dim" : "text-ink-soft group-hover:text-ink-muted"
          }`}
        >
          {detail}
        </span>
        {call.diff && <DiffStat additions={call.diff.additions} deletions={call.diff.deletions} />}
        <span className="flex-1" />
        {payload && (
          <ChevronRight
            size={10}
            className={`text-ink-disabled opacity-0 group-hover:opacity-100 transition-all duration-ds ease-ds ${open ? "rotate-90 opacity-100" : ""}`}
          />
        )}
      </button>

      {open && (
        <div className="my-1 rounded-md bg-frame-bot border border-edge-code px-2.5 py-2 animate-reveal">
          <div className="font-mono text-3xs text-ink-disabled mb-1">{call.name}</div>
          {Object.keys(call.arguments ?? {}).length > 0 && (
            <pre className="font-mono text-3xs text-ink-code/80 whitespace-pre-wrap break-words max-h-36 overflow-y-auto">
              {JSON.stringify(call.arguments, null, 2)}
            </pre>
          )}
          {call.result && (
            <pre
              className={`font-mono text-3xs whitespace-pre-wrap break-words max-h-44 overflow-y-auto mt-1.5 pt-1.5 border-t border-edge/50 ${
                failed ? "text-danger/90" : "text-ink-code/80"
              }`}
            >
              {call.result}
            </pre>
          )}
          {call.diff?.diffText && (
            <pre className="font-mono text-3xs whitespace-pre-wrap break-words max-h-52 overflow-y-auto mt-1.5 pt-1.5 border-t border-edge/50">
              {call.diff.diffText.split("\n").map((line, index) => (
                <div
                  key={index}
                  className={
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "text-success"
                      : line.startsWith("-") && !line.startsWith("---")
                        ? "text-danger"
                        : "text-ink-soft"
                  }
                >
                  {line}
                </div>
              ))}
            </pre>
          )}
          {call.diff?.file && onJumpToFile && (
            <button
              type="button"
              onClick={() => onJumpToFile(call.diff!.file, "")}
              className="mt-1.5 text-2xs text-accent hover:underline"
            >
              Open {call.diff.file.split("/").pop()}
            </button>
          )}
        </div>
      )}
    </li>
  );
};

const StatusGlyph: React.FC<{ status: "running" | "error" | "done"; kind: ActivityKind }> = ({ status, kind }) =>
  status === "running" ? (
    <Loader2 size={11} className="animate-spin text-ink-faint flex-shrink-0" />
  ) : status === "error" ? (
    <AlertCircle size={11} className="text-danger/80 flex-shrink-0" />
  ) : (
    <span className="text-ink-disabled flex-shrink-0 flex items-center">{GLYPHS[kind] ?? <Check size={11} />}</span>
  );

const DiffStat: React.FC<{ additions: number; deletions: number }> = ({ additions, deletions }) => (
  <span className="font-mono text-3xs tabular-nums flex items-center gap-1 flex-shrink-0">
    {additions > 0 && <span className="text-success/80">+{additions}</span>}
    {deletions > 0 && <span className="text-danger/80">−{deletions}</span>}
  </span>
);

function formatElapsed(seconds: number): string {
  return seconds < 60 ? `${seconds.toFixed(0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Seconds since the turn began, ticking only while it is live. */
function useElapsed(active: boolean): number {
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    startedAt.current = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  return elapsed;
}
