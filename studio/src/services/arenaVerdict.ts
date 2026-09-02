/**
 * The arena's pure logic: the watcher's brief, its verdict, and who may judge.
 *
 * Standalone by design — no imports at all — so the node test runner can reach
 * it. These three functions decide whether a benchmark result means anything,
 * which makes them the part most worth testing.
 */

/** Kept local rather than imported, so this module stays dependency-free. */
export type ArenaEngine = "claude" | "codex";

export interface ArenaContestantRef {
  id: string;
  kind: "frontier" | ArenaEngine;
  label: string;
  model: string | null;
}

export interface ArenaMeasurement {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  files: { status: string; path: string }[];
  diff: string;
  diffTruncated: boolean;
  checks: { name: string; command: string; passed: boolean; durationMs: number; output: string }[];
}

export interface ArenaResult {
  contestant: ArenaContestantRef;
  transcript: string;
  toolCalls: number;
  durationMs: number;
  tokens: number;
  costUsd: number | null;
  error: string | null;
  measurement: ArenaMeasurement | null;
}

export interface Verdict {
  winner: string | null;
  summary: string;
  scores: Record<string, { correctness?: number; scope?: number; readability?: number; regressions?: number; evidence?: string }>;
  behaviour: Record<string, { verifiedOwnWork?: boolean; readBeforeEditing?: boolean; stayedOnTask?: boolean; notes?: string }>;
  improvements: string[];
  /** Raw text, kept so a malformed verdict is still readable. */
  raw: string;
}

/**
 * The watcher's brief.
 *
 * Written as an instruction to a coding agent rather than a chat prompt: it is
 * handed real diffs and real check results and asked for one JSON object. The
 * demand for evidence is the important part — a score without a cited line is
 * an opinion, and this benchmark exists to replace opinions with measurements.
 */
export function watcherPrompt(task: string, results: ArenaResult[], watcherEngine: ArenaEngine | null = null): string {
  const sections = results.map((result) => {
    const m = result.measurement;
    return [
      `### ${result.contestant.label}  (id: ${result.contestant.id})`,
      `- completed: ${result.error ? `no — ${result.error}` : "yes"}`,
      `- duration: ${(result.durationMs / 1000).toFixed(1)}s · tool calls: ${result.toolCalls} · tokens: ${result.tokens}` +
        (result.costUsd !== null ? ` · cost: $${result.costUsd.toFixed(4)}` : " · cost: not reported"),
      m
        ? `- files changed: ${m.filesChanged} (+${m.linesAdded} / -${m.linesRemoved})`
        : "- files changed: not measured",
      m?.checks.length ? `- checks: ${m.checks.map((c) => `${c.name}=${c.passed ? "PASS" : "FAIL"}`).join(", ")}` : "",
      "",
      "#### What it said",
      "```",
      result.transcript.slice(-4_000) || "(no output)",
      "```",
      "",
      "#### What it actually changed",
      "```diff",
      m?.diff?.slice(0, 12_000) || "(no changes on disk)",
      "```",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    "You are judging a head-to-head benchmark between AI coding assistants.",
    "Each worked alone, on an identical private copy of the same repository, on this task:",
    "",
    `TASK: ${task}`,
    "",
    "Below, for each contestant: what it said, and the real git diff of what it changed.",
    "The diff is ground truth — if a contestant claims an edit that is not in its diff, say so.",
    "",
    ...sections,
    "",
    "Reply with ONE json object and nothing else, in a ```json fence:",
    "{",
    '  "winner": "<contestant id, or null if genuinely tied>",',
    '  "summary": "<two sentences on what separated them>",',
    '  "scores": { "<id>": { "correctness": 1-5, "scope": 1-5, "readability": 1-5, "regressions": 1-5, "evidence": "<cite specific files/lines>" } },',
    '  "behaviour": { "<id>": { "verifiedOwnWork": bool, "readBeforeEditing": bool, "stayedOnTask": bool, "notes": "<one line>" } },',
    '  "improvements": ["<concrete change the Frontier platform should make to close the gap>"]',
    "}",
    "",
    "Scoring rules: `scope` penalises edits beyond the task. `regressions` is 5 when nothing",
    "adjacent broke. Every score must be justified by `evidence` citing real paths from the",
    "diffs above — a score you cannot evidence should be omitted rather than guessed.",
    "Do not run any commands or edit any files. Read what is above and reply.",
    ...(results.some((r) => r.contestant.kind === watcherEngine)
      ? [
          "",
          "NOTE: one of the contestants above is you. Judge your own work by the same",
          "evidence you apply to the other — if its diff is worse, say so plainly.",
        ]
      : []),
  ].join("\n");
}

/** Pulls the verdict out of the watcher's reply, tolerating chatter around it. */
export function parseVerdict(raw: string): Verdict {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);

  try {
    const parsed = JSON.parse(candidate);
    return {
      winner: typeof parsed.winner === "string" ? parsed.winner : null,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      scores: parsed.scores && typeof parsed.scores === "object" ? parsed.scores : {},
      behaviour: parsed.behaviour && typeof parsed.behaviour === "object" ? parsed.behaviour : {},
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements.filter((s: unknown) => typeof s === "string") : [],
      raw,
    };
  } catch {
    // A watcher that ignored the schema still said something useful; showing
    // its prose beats showing an error where the verdict should be.
    return { winner: null, summary: "", scores: {}, behaviour: {}, improvements: [], raw };
  }
}

/**
 * Which agents may judge: any that is installed.
 *
 * An earlier version excluded whichever agent was competing, on the grounds
 * that it would be grading its own work. That is the wrong trade here — the
 * subject under test is Frontier, and the challenger is the reference it is
 * measured against, so locking the operator out of their preferred judge costs
 * more than the bias does.
 *
 * The bias is not ignored, only surfaced: `isSelfGraded` marks a run where the
 * watcher also competed, and the verdict says so wherever it appears.
 */
export function eligibleWatchers(_contestants: ArenaContestantRef[]): ArenaEngine[] {
  return ["claude", "codex"];
}

/** True when the watcher also competed in the match it is judging. */
export function isSelfGraded(watcher: ArenaEngine | null, contestants: ArenaContestantRef[]): boolean {
  return Boolean(watcher && contestants.some((contestant) => contestant.kind === watcher));
}

/**
 * The run as markdown: copyable, and readable by a model.
 *
 * One format for both destinations. The clipboard version and the one handed to
 * the chat must not drift apart — a report you paste into an issue and a report
 * you ask the assistant to act on should describe the same run.
 *
 * Measured facts come first and the watcher's opinion last, because the numbers
 * are the part that is true regardless of which agent judged.
 */
export function formatBenchmarkReport(
  task: string,
  results: ArenaResult[],
  verdict: Verdict | null,
  watcher: ArenaEngine | null,
  selfGraded = false,
): string {
  const lines: string[] = ["## Benchmark", "", `**Task** — ${task}`, ""];

  lines.push("| | " + results.map((r) => r.contestant.label).join(" | "));
  lines.push("|---|" + results.map(() => "---|").join(""));
  const row = (label: string, pick: (r: ArenaResult) => string) =>
    lines.push(`| ${label} | ` + results.map(pick).join(" | "));

  row("Completed", (r) => (r.error ? `no — ${r.error}` : "yes"));
  row("Files changed", (r) => (r.measurement ? String(r.measurement.filesChanged) : "—"));
  row("Lines", (r) => (r.measurement ? `+${r.measurement.linesAdded} / −${r.measurement.linesRemoved}` : "—"));
  row("Tool calls", (r) => String(r.toolCalls));
  row("Duration", (r) => `${(r.durationMs / 1000).toFixed(1)}s`);
  row("Tokens", (r) => (r.tokens ? r.tokens.toLocaleString() : "—"));
  // An agent that reports no cost did not cost nothing.
  row("Cost", (r) => (r.costUsd !== null ? `$${r.costUsd.toFixed(4)}` : "not reported"));

  const checkNames = [...new Set(results.flatMap((r) => r.measurement?.checks.map((c) => c.name) ?? []))];
  for (const name of checkNames) {
    row(name, (r) => {
      const check = r.measurement?.checks.find((c) => c.name === name);
      return check ? (check.passed ? "pass" : "**fail**") : "—";
    });
  }

  if (verdict) {
    lines.push("", `### Verdict${watcher ? ` — judged by ${watcher}` : ""}`);
    if (selfGraded) lines.push("", "> Self-graded: the watcher also competed in this run.");
    if (verdict.winner) {
      const winner = results.find((r) => r.contestant.id === verdict.winner);
      lines.push("", `**Winner:** ${winner?.contestant.label ?? verdict.winner}`);
    }
    if (verdict.summary) lines.push("", verdict.summary);

    for (const result of results) {
      const score = verdict.scores?.[result.contestant.id];
      if (!score) continue;
      const parts = (["correctness", "scope", "readability", "regressions"] as const)
        .filter((key) => typeof score[key] === "number")
        .map((key) => `${key} ${score[key]}/5`);
      if (parts.length === 0 && !score.evidence) continue;
      lines.push("", `- **${result.contestant.label}** — ${parts.join(" · ")}`);
      if (score.evidence) lines.push(`  ${score.evidence}`);
    }

    if (verdict.improvements.length > 0) {
      lines.push("", "### What Frontier should change", "");
      verdict.improvements.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
  }

  return lines.join("\n");
}
