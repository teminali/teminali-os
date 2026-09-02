import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Gavel,
  History,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  ShieldAlert,
  Square,
} from "lucide-react";
import {
  ArenaService,
  DEFAULT_CHECKS,
  applyMeasureEvent,
  eligibleWatchers,
  formatBenchmarkReport,
  formatElapsed,
  isLaneBusy,
  isSelfGraded,
  parseVerdict,
  pendingChecks,
  watcherPrompt,
  type ArenaRunRecord,
  type Contestant,
  type ContestantResult,
  type Verdict,
} from "../../../services/arenaService";
import { ArenaLane, StreamBox, type Lane } from "./ArenaLane";
import { AgentCliService, type AgentDescriptor, type AgentEngine } from "../../../services/agentCliService";
import { AIService } from "../../../services/aiService";
import { PlatformService, type Identity } from "../../../services/platformService";
import { PROFILES_LIST, useStudioStore } from "../../../store/studioStore";
import { BrandGlyph, EmptyState } from "../../ui";
import type { ModelProfileId } from "../../../types";

/**
 * The benchmark arena.
 *
 * One task, two assistants, two private copies of the workspace, and a third
 * agent that grades the result. It exists to answer "is Frontier actually
 * competitive" with evidence rather than impression — which is why every number
 * on screen is measured from disk rather than reported by the contestant.
 *
 * Four properties are load-bearing:
 *
 *   1. **Isolation.** Each contestant edits its own sandbox. Sharing a working
 *      tree would mean they read each other's half-finished work and the loser
 *      is whoever ran second.
 *   2. **Ground truth is the diff.** The transcript says what an assistant
 *      claims it did; `git diff` in its sandbox says what it did.
 *   3. **Self-grading is disclosed, not prevented.** Either agent may judge,
 *      including one that is competing — the operator's preferred judge is
 *      worth more than the bias costs, so the bias is labelled instead.
 *   4. **It is watchable.** Every stage streams: the agents' output token by
 *      token, their tool calls as they run, then the diff and each check as it
 *      lands. A benchmark you can only read afterwards is a report; this is an
 *      instrument, and the difference is the whole value of the panel.
 *
 * The pipeline is per-contestant rather than in lockstep: whoever finishes first
 * is measured and verified immediately instead of waiting for the slower one, so
 * the panel is never idle while there is work to show.
 */

const FRONTIER_LANES: { id: ModelProfileId; label: string }[] = PROFILES_LIST.map((profile) => ({
  id: profile.id,
  label: profile.name,
}));

type Phase = "idle" | "preparing" | "running" | "judging" | "done";

/** The judge, watched the same way the contestants are. */
interface Judge {
  engine: AgentEngine;
  text: string;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

/** Buffer key for the watcher's stream; contestants use their own ids. */
const JUDGE_KEY = " judge";

export const ArenaPane: React.FC = () => {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [agents, setAgents] = useState<Record<AgentEngine, AgentDescriptor> | null>(null);

  const [task, setTask] = useState("");
  const [lane, setLane] = useState<ModelProfileId>("auto");
  const [challenger, setChallenger] = useState<AgentEngine>("claude");
  const [watcher, setWatcher] = useState<AgentEngine | null>(null);
  const [runChecks, setRunChecks] = useState(true);

  const [phase, setPhase] = useState<Phase>("idle");
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [judge, setJudge] = useState<Judge | null>(null);
  const [showJudgeStream, setShowJudgeStream] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<ArenaRunRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  /** Moves the live clocks. One timer for the panel, not one per lane. */
  const [now, setNow] = useState(() => Date.now());

  const setChatDraft = useStudioStore((state) => state.setChatDraft);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Tokens arriving faster than the screen can use them.
   *
   * Two agents stream concurrently and each emits thousands of tokens; a
   * setState per token would re-render this panel hundreds of times a second
   * and drop frames on the very thing it exists to show. Tokens land here and
   * are applied on a tick instead.
   */
  const buffers = useRef<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      PlatformService.me(controller.signal),
      AgentCliService.available(controller.signal),
    ]).then(([who, available]) => {
      if (controller.signal.aborted) return;
      setIdentity(who);
      setAgents(available);
    });
    void ArenaService.history(30, controller.signal).then((runs) => {
      if (!controller.signal.aborted) setHistory(runs);
    });
    return () => controller.abort();
  }, []);

  const contestants: Contestant[] = [
    { id: "frontier", kind: "frontier", label: FRONTIER_LANES.find((l) => l.id === lane)?.label ?? "Frontier", model: lane },
    { id: challenger, kind: challenger, label: agents?.[challenger]?.label ?? challenger, model: null },
  ];

  const watchers = eligibleWatchers(contestants).filter((engine) => agents?.[engine]?.installed);
  const selfGraded = isSelfGraded(watcher, contestants);
  // Keep the selection as long as it is still installed; the watcher is no
  // longer narrowed by who is competing.
  useEffect(() => {
    setWatcher((current) => (current && watchers.includes(current) ? current : watchers[0] ?? null));
  }, [challenger, agents]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = phase !== "idle" && phase !== "done";

  /* ── Live plumbing ──────────────────────────────────────────────────────── */

  const patchLane = useCallback((id: string, patch: Partial<Lane> | ((current: Lane) => Partial<Lane>)) => {
    setLanes((previous) =>
      previous.map((entry) =>
        entry.contestant.id === id ? { ...entry, ...(typeof patch === "function" ? patch(entry) : patch) } : entry,
      ),
    );
  }, []);

  // Drained outside the updater, so React's double-invoked updaters in
  // development cannot swallow a burst of tokens.
  const flush = useCallback(() => {
    const drained = buffers.current;
    buffers.current = {};
    if (Object.keys(drained).length === 0) return;
    if (drained[JUDGE_KEY]) {
      setJudge((current) => (current ? { ...current, text: current.text + drained[JUDGE_KEY] } : current));
    }
    setLanes((previous) =>
      previous.map((entry) =>
        drained[entry.contestant.id] ? { ...entry, text: entry.text + drained[entry.contestant.id] } : entry,
      ),
    );
  }, []);

  useEffect(() => {
    if (!busy) {
      flush();
      return;
    }
    const timer = window.setInterval(() => {
      flush();
      setNow(Date.now());
    }, 120);
    return () => {
      window.clearInterval(timer);
      flush();
    };
  }, [busy, flush]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  /* ── The run ────────────────────────────────────────────────────────────── */

  const run = async () => {
    const prompt = task.trim();
    if (!prompt || busy) return;

    const runId = `run${Date.now().toString(36)}`;
    const controller = new AbortController();
    abortRef.current = controller;
    const verify = runChecks ? DEFAULT_CHECKS : [];

    buffers.current = {};
    setFailure(null);
    setVerdict(null);
    setJudge(null);
    setCopied(false);
    setShowHistory(false);
    setLanes(
      contestants.map((contestant) => ({
        contestant,
        status: "preparing",
        sandbox: null,
        text: "",
        tools: [],
        tokens: 0,
        costUsd: null,
        startedAt: null,
        endedAt: null,
        error: null,
        checks: pendingChecks(verify),
        measurement: null,
      })),
    );
    setPhase("preparing");

    try {
      const sandboxes = await ArenaService.createSandboxes(runId, contestants.map((entry) => entry.id));
      const sandboxOf = (id: string) => sandboxes.find((entry) => entry.contestantId === id) ?? null;

      setPhase("running");
      // Both start together: a benchmark where one waits for the other measures
      // patience, not capability. Each then measures itself the moment it
      // finishes, rather than queueing behind the slower one.
      const pipeline = contestants.map(async (contestant): Promise<ContestantResult> => {
        const id = contestant.id;
        const sandbox = sandboxOf(id);
        const base: ContestantResult = {
          contestant,
          sandbox,
          transcript: "",
          toolCalls: 0,
          durationMs: 0,
          tokens: 0,
          costUsd: null,
          error: null,
          measurement: null,
        };
        if (!sandbox) {
          patchLane(id, { status: "failed", error: "No sandbox was created." });
          return { ...base, error: "No sandbox was created." };
        }

        patchLane(id, { sandbox, status: "working", startedAt: Date.now() });
        const startedAt = Date.now();
        let text = "";
        let tokens = 0;
        let cost: number | null = null;
        let error: string | null = null;
        // Counted by id out here rather than from inside the state updater: a
        // tool is reported twice, once running and once settled, and an updater
        // is not allowed to be the thing that counts.
        const toolIds = new Set<string>();

        const callbacks = {
          onToken: (token: string) => {
            text += token;
            buffers.current[id] = (buffers.current[id] ?? "") + token;
          },
          onToolCall: (call: Lane["tools"][number]) => {
            toolIds.add(call.id);
            patchLane(id, (current) => {
              const at = current.tools.findIndex((entry) => entry.id === call.id);
              return {
                tools: at >= 0 ? current.tools.map((entry, index) => (index === at ? call : entry)) : [...current.tools, call],
              };
            });
          },
          onComplete: (data: { fullText: string; tokensCount: number; costUsd: number }) => {
            text = data.fullText || text;
            tokens = data.tokensCount;
            cost = data.costUsd;
            // The settled text supersedes anything still buffered; keeping both
            // would print the tail of the turn twice.
            delete buffers.current[id];
            patchLane(id, { text, tokens, costUsd: cost });
          },
          onError: (failed: Error) => {
            error = failed.message;
          },
        };

        try {
          if (contestant.kind === "frontier") {
            await AIService.streamMessage("frontier", prompt, [], callbacks, [], {
              mode: contestant.model as ModelProfileId,
              signal: controller.signal,
              // The whole point: the local engine's commands run in the sandbox.
              workingDirectory: sandbox.relativePath,
            });
          } else {
            const turn = await AgentCliService.streamTurn(
              {
                engine: contestant.kind,
                prompt,
                cwd: sandbox.relativePath,
                permission: agents?.[contestant.kind]?.defaultPermission,
                signal: controller.signal,
              },
              callbacks,
            );
            cost = turn.costUsd;
          }
        } catch (thrown) {
          error = error ?? (thrown instanceof Error ? thrown.message : "The run failed.");
        }

        const durationMs = Date.now() - startedAt;
        const stopped = controller.signal.aborted;
        patchLane(id, { status: stopped ? "stopped" : "measuring", endedAt: Date.now(), tokens, costUsd: cost, error });
        if (stopped) return { ...base, transcript: text, toolCalls: toolIds.size, durationMs, tokens, costUsd: cost, error };

        // Measured stage by stage, so the diff appears immediately and each
        // check goes green or red on its own rather than all at the end.
        let measurement: ContestantResult["measurement"] = null;
        try {
          measurement = await ArenaService.measureStream(
            runId,
            id,
            verify,
            (event) =>
              patchLane(id, (current) =>
                applyMeasureEvent(
                  { status: current.status, checks: current.checks, measurement: current.measurement },
                  event,
                ),
              ),
            controller.signal,
          );
        } catch {
          // A measurement that failed is worth less than the run it describes;
          // the transcript and the tool timeline are still on screen.
        }
        patchLane(id, {
          status: controller.signal.aborted ? "stopped" : error ? "failed" : "done",
          measurement,
        });

        return { ...base, transcript: text, toolCalls: toolIds.size, durationMs, tokens, costUsd: cost, error, measurement };
      });

      const measured = await Promise.all(pipeline);
      if (controller.signal.aborted) {
        setPhase("done");
        void ArenaService.cleanup(runId);
        return;
      }

      let verdictForRun: Verdict | null = null;
      if (watcher) {
        setPhase("judging");
        setJudge({ engine: watcher, text: "", startedAt: Date.now(), endedAt: null, error: null });
        let raw = "";
        await AgentCliService.streamTurn(
          {
            engine: watcher,
            prompt: watcherPrompt(prompt, measured, watcher),
            // The watcher reads and reports; it is given the read-only rung so
            // it cannot "helpfully" edit either contestant's work.
            permission: watcher === "claude" ? "manual" : "read-only",
            signal: controller.signal,
          },
          {
            onToken: (token) => {
              raw += token;
              buffers.current[JUDGE_KEY] = (buffers.current[JUDGE_KEY] ?? "") + token;
            },
            onComplete: (data) => {
              raw = data.fullText || raw;
              delete buffers.current[JUDGE_KEY];
              setJudge((current) => (current ? { ...current, text: raw, endedAt: Date.now() } : current));
            },
            onError: (failed) => {
              setFailure(`The watcher failed: ${failed.message}`);
              setJudge((current) => (current ? { ...current, endedAt: Date.now(), error: failed.message } : current));
            },
          },
        ).catch(() => {
          /* onError already recorded it. */
        });
        if (raw) {
          verdictForRun = parseVerdict(raw);
          setVerdict(verdictForRun);
        }
      }

      // Recorded after judging so the entry carries the verdict too. The diffs
      // are not kept — the sandboxes they came from are about to be deleted.
      const record: ArenaRunRecord = {
        runId,
        task: prompt,
        watcher,
        selfGraded,
        winner: verdictForRun?.winner ?? null,
        summary: verdictForRun?.summary ?? "",
        improvements: verdictForRun?.improvements ?? [],
        contestants: measured.map((result) => ({
          id: result.contestant.id,
          label: result.contestant.label,
          kind: result.contestant.kind,
          model: result.contestant.model,
          completed: !result.error,
          filesChanged: result.measurement?.filesChanged ?? 0,
          linesAdded: result.measurement?.linesAdded ?? 0,
          linesRemoved: result.measurement?.linesRemoved ?? 0,
          toolCalls: result.toolCalls,
          durationMs: Math.round(result.durationMs),
          tokens: result.tokens,
          costUsd: result.costUsd,
          checks: result.measurement?.checks.map((check) => ({ name: check.name, passed: check.passed })) ?? [],
        })),
      };
      await ArenaService.recordRun(record);
      setHistory((current) => [{ ...record, at: new Date().toISOString() }, ...current].slice(0, 30));

      setPhase("done");
      void ArenaService.cleanup(runId);
    } catch (thrown) {
      setFailure(thrown instanceof Error ? thrown.message : "The benchmark failed.");
      // A run that fell over before either agent started has nothing to show
      // and nothing to report; leaving two empty lanes and a Copy button would
      // dress a failure up as a result.
      setLanes((previous) =>
        previous.some((entry) => entry.startedAt !== null)
          ? previous.map((entry) => (isLaneBusy(entry.status) ? { ...entry, status: "failed" } : entry))
          : [],
      );
      setPhase("done");
      void ArenaService.cleanup(runId);
    }
  };

  if (identity && !identity.isAdmin) {
    return (
      <EmptyState
        title="Administrators only"
        detail={identity.reason ?? "The benchmark arena runs agents and spends money, so it is limited to administrators."}
      />
    );
  }

  const results: ContestantResult[] = lanes.map((entry) => ({
    contestant: entry.contestant,
    sandbox: entry.sandbox,
    transcript: entry.text,
    toolCalls: entry.tools.length,
    durationMs: entry.startedAt === null ? 0 : (entry.endedAt ?? now) - entry.startedAt,
    tokens: entry.tokens,
    costUsd: entry.costUsd,
    error: entry.error,
    measurement: entry.measurement,
  }));
  const report = () => formatBenchmarkReport(task, results, verdict, watcher, selfGraded);
  const settled = lanes.length > 0 && lanes.every((entry) => !isLaneBusy(entry.status));

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-8 flex-shrink-0 flex items-center justify-between pl-3.5 pr-2">
        <span className="text-sm text-ink-faint">Benchmark</span>
        <div className="flex items-center gap-1">
          {busy && (
            <span className="flex items-center gap-1 text-2xs text-ink-soft">
              <LoaderCircle size={10} className="animate-spin" />
              {phase === "preparing" ? "Preparing" : phase === "judging" ? "Judging" : "Running"}
            </span>
          )}
          {history.length > 0 && (
            <button
              type="button"
              onClick={() => setShowHistory((open) => !open)}
              title={`${history.length} past ${history.length === 1 ? "run" : "runs"}`}
              className={`h-6 px-2 rounded-md flex items-center gap-1 text-2xs transition-colors duration-ds ease-ds ${
                showHistory ? "bg-surface-active text-ink-strong" : "text-ink-muted hover:bg-surface-hover"
              }`}
            >
              <History size={12} />
              {history.length}
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 space-y-3">
        {/* ── Past runs ──────────────────────────────────────────────────────
            Kept so a change to Frontier can be judged against how it did last
            week, which is the only way to tell improvement from noise. */}
        {showHistory && (
          <div className="space-y-1">
            {history.map((entry, index) => {
              const winner = entry.contestants.find((c) => c.id === entry.winner);
              return (
                <button
                  key={`${entry.runId}-${index}`}
                  type="button"
                  onClick={() => setTask(entry.task)}
                  title="Load this task back into the box"
                  className="w-full text-left rounded-md px-2.5 py-2 bg-surface-sunken hover:bg-surface-hover transition-colors duration-ds ease-ds"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 truncate text-2xs text-ink-body">{entry.task || "(no task)"}</span>
                    {entry.selfGraded && <span className="text-3xs text-warning flex-shrink-0">self-graded</span>}
                    <span className="text-3xs text-ink-soft flex-shrink-0">
                      {entry.at ? new Date(entry.at).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 pt-0.5 text-3xs text-ink-soft">
                    <span className="truncate">{entry.contestants.map((c) => c.label).join(" vs ")}</span>
                    {winner && <span className="text-ink-muted flex-shrink-0">· {winner.label} won</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* ── Setup ──────────────────────────────────────────────────────────
            Collapsed to a summary while a run is live: mid-benchmark the panel
            belongs to the run, not to the controls that started it. */}
        {busy ? (
          <div className="rounded-lg bg-surface-sunken border border-edge px-2.5 py-2">
            <p className="text-2xs text-ink-body leading-relaxed line-clamp-2">{task}</p>
            <p className="pt-1 text-3xs text-ink-soft truncate">
              {contestants.map((entry) => entry.label).join(" vs ")}
              {watcher ? ` · judged by ${agents?.[watcher]?.label ?? watcher}` : ""}
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-lg bg-surface-sunken border border-edge p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <Select value={lane} onChange={(value) => setLane(value as ModelProfileId)}>
                  {FRONTIER_LANES.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.label}</option>
                  ))}
                </Select>
                <span className="text-2xs text-ink-soft flex-shrink-0">vs</span>
                <Select value={challenger} onChange={(value) => setChallenger(value as AgentEngine)}>
                  {(["claude", "codex"] as AgentEngine[])
                    .filter((engine) => agents?.[engine]?.installed)
                    .map((engine) => (
                      <option key={engine} value={engine}>{agents?.[engine]?.label ?? engine}</option>
                    ))}
                </Select>
              </div>

              <div className="flex items-center gap-2">
                <Gavel size={12} className="text-ink-muted flex-shrink-0" />
                <span className="text-2xs text-ink-muted flex-shrink-0">Watcher</span>
                <Select
                  value={watcher ?? ""}
                  onChange={(value) => setWatcher(value as AgentEngine)}
                  disabled={watchers.length === 0}
                >
                  {watchers.map((engine) => (
                    <option key={engine} value={engine}>{agents?.[engine]?.label ?? engine}</option>
                  ))}
                </Select>
              </div>

              {/* A judge that is also competing is disclosed rather than
                  refused: the operator's preferred judge is worth more than the
                  bias costs, provided nobody reads the verdict without it. */}
              <p className={`text-3xs leading-relaxed ${selfGraded ? "text-warning" : "text-ink-soft"}`}>
                {watchers.length === 0
                  ? "No agent CLI is installed, so this run cannot be judged."
                  : selfGraded
                    ? `${agents?.[watcher as AgentEngine]?.label ?? watcher} is also competing, so it will be grading its own work.`
                    : "The watcher reads both diffs and scores them; it never edits either."}
              </p>

              <label className="flex items-center gap-2 text-2xs text-ink-muted cursor-pointer">
                <input type="checkbox" checked={runChecks} onChange={(event) => setRunChecks(event.target.checked)} />
                Run typecheck and tests in each sandbox afterwards
              </label>
            </div>

            <textarea
              value={task}
              onChange={(event) => setTask(event.target.value)}
              rows={3}
              placeholder="The task both assistants will be given, in their own copy of this workspace"
              className="lit w-full px-2.5 py-2 rounded-md bg-surface text-sm text-ink-high placeholder:text-ink-placeholder outline-none resize-none"
            />
          </>
        )}

        <button
          type="button"
          onClick={() => (busy ? stop() : void run())}
          disabled={!busy && (!task.trim() || watchers.length === 0)}
          className={`w-full h-8 rounded-md text-sm flex items-center justify-center gap-2 transition-colors duration-ds ease-ds disabled:opacity-40 ${
            busy ? "bg-danger/20 text-danger" : "bg-surface-raised hover:bg-surface-hover text-ink-high"
          }`}
        >
          {busy ? <Square size={11} fill="currentColor" /> : <Play size={12} />}
          {busy ? "Stop" : lanes.length > 0 ? "Run again" : "Run benchmark"}
        </button>

        {lanes.length === 0 && (
          <p className="flex items-start gap-1.5 text-3xs text-ink-soft leading-relaxed">
            <ShieldAlert size={11} className="flex-shrink-0 mt-0.5" />
            Each assistant works in a private copy of this workspace. Your real files are never touched.
          </p>
        )}

        {failure && <p className="text-2xs text-danger leading-relaxed">{failure}</p>}

        {/* ── The run, live ──────────────────────────────────────────────── */}
        {lanes.map((entry) => (
          <ArenaLane
            key={entry.contestant.id}
            lane={entry}
            now={now}
            score={verdict?.scores?.[entry.contestant.id]}
            isWinner={verdict?.winner === entry.contestant.id}
          />
        ))}

        {/* ── The verdict, as it is being written ────────────────────────── */}
        {judge && (
          <div className="rounded-lg bg-surface-sunken border border-edge p-2.5 space-y-2">
            <div className="flex items-center gap-1.5">
              <Gavel size={12} className="text-ink-muted flex-shrink-0" />
              <span className="text-2xs text-ink-muted">Judged by</span>
              <BrandGlyph brand={judge.engine} size={13} />
              <span className="text-2xs text-ink-muted truncate">{agents?.[judge.engine]?.label ?? judge.engine}</span>
              {/* Not a blocker, but someone reading this verdict a week from now
                  must be able to tell a self-graded win from an independent one. */}
              {selfGraded && (
                <span className="text-3xs px-1.5 py-0.5 rounded-full bg-warning/15 text-warning flex-shrink-0">
                  self-graded
                </span>
              )}
              <span className="flex-1" />
              <span className="text-2xs text-ink-soft tabular-nums flex-shrink-0">
                {formatElapsed((judge.endedAt ?? now) - judge.startedAt)}
              </span>
            </div>

            {/* While it is thinking, its reasoning is the only thing there is to
                show — and it is worth showing: it is the argument behind the
                score that arrives a minute later. */}
            {!verdict && <StreamBox text={judge.text} live={judge.endedAt === null} height={132} />}

            {verdict?.summary && <p className="text-2xs text-ink-body leading-relaxed">{verdict.summary}</p>}

            {verdict && verdict.improvements.length > 0 && (
              <div className="pt-1 border-t border-edge">
                <div className="text-2xs text-ink-muted pb-1">What Frontier should change</div>
                <ul className="space-y-1">
                  {verdict.improvements.map((item, index) => (
                    <li key={index} className="text-2xs text-ink-body leading-relaxed flex gap-1.5">
                      <span className="text-ink-disabled flex-shrink-0">{index + 1}.</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* A watcher that ignored the schema still said something useful. */}
            {verdict && !verdict.summary && verdict.improvements.length === 0 && (
              <pre className="max-h-40 overflow-y-auto font-mono text-3xs text-ink-code whitespace-pre-wrap">
                {verdict.raw}
              </pre>
            )}

            {verdict && judge.text && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowJudgeStream((open) => !open)}
                  className="flex items-center gap-1 text-2xs text-ink-muted hover:text-ink-high transition-colors duration-ds ease-ds"
                >
                  {showJudgeStream ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  Reasoning
                </button>
                {showJudgeStream && (
                  <div className="mt-1">
                    <StreamBox text={judge.text} live={false} height={160} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Take the result somewhere ──────────────────────────────────
            One formatter feeds both, so a report pasted into an issue and one
            handed to the assistant describe the same run. */}
        {settled && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(report());
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1600);
                } catch {
                  // Clipboard blocked; the report is still reachable by sending
                  // it to the chat, so this is not worth an error banner.
                }
              }}
              className="flex-1 h-7 rounded-md bg-surface-raised hover:bg-surface-hover text-2xs text-ink-high flex items-center justify-center gap-1.5 transition-colors duration-ds ease-ds"
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy report"}
            </button>
            <button
              type="button"
              onClick={() => setChatDraft(report())}
              title="Puts the report in the main composer, for you to send or edit"
              className="flex-1 h-7 rounded-md bg-surface-raised hover:bg-surface-hover text-2xs text-ink-high flex items-center justify-center gap-1.5 transition-colors duration-ds ease-ds"
            >
              <MessageSquarePlus size={12} />
              Send to chat
            </button>
          </div>
        )}

        {phase === "idle" && lanes.length === 0 && !failure && (
          <p className="text-2xs text-ink-soft leading-relaxed pt-2">
            Give both assistants the same task. Each works alone in its own copy of this workspace and you watch
            both of them work — then {watchers.length > 0 ? (agents?.[watchers[0]]?.label ?? "a watcher") : "a watcher"}{" "}
            compares what they actually changed and says what Frontier should do differently.
          </p>
        )}
      </div>
    </div>
  );
};

/* ── Pieces ───────────────────────────────────────────────────────────────── */

const Select: React.FC<{
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ value, onChange, disabled, children }) => (
  <select
    value={value}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value)}
    className="flex-1 min-w-0 h-7 px-2 rounded-md bg-surface text-2xs text-ink-body outline-none disabled:opacity-40"
  >
    {children}
  </select>
);
