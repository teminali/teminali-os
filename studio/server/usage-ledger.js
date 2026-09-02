/**
 * What every turn cost, recorded once and aggregated on read.
 *
 * The ledger is append-only JSONL: one line per turn, never rewritten. That
 * shape is deliberate — a running total in a JSON blob has to be read, mutated
 * and written back on every turn, and two turns finishing together lose one of
 * them. Appending a line cannot lose a turn, and every question the dashboard
 * asks ("per model", "per day", "the 7-day average") is answerable by reading
 * the lines back and grouping them.
 *
 * A record is a *fact about one turn*: when, which engine, which model, the
 * four token counts, and the cost if the agent reported one. `costUsd` is null
 * rather than 0 when it was not reported — Codex bills against a subscription
 * and never returns a figure, and averaging an unreported cost as zero would
 * quietly understate every total it appears in.
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Keeps the file bounded without losing the recent past. */
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_LINES = 5_000;

/**
 * One turn.
 *
 * `models` is a list because a single agent turn routinely uses more than one —
 * a cheap model for a side task, the selected one for the reply — and "usage per
 * model" is only answerable if that breakdown survives into the record.
 */
export function usageRecord({ engine, model, models = [], usage, costUsd, durationMs, at = new Date() }) {
  const tokens = {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.cacheReadTokens ?? 0,
    cacheCreation: usage?.cacheCreationTokens ?? 0,
  };
  return {
    at: at.toISOString(),
    engine,
    model: model ?? null,
    tokens,
    total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation,
    costUsd: typeof costUsd === "number" ? costUsd : null,
    durationMs: typeof durationMs === "number" ? durationMs : null,
    models: models.map((entry) => ({
      id: entry.id,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
      cacheReadTokens: entry.cacheReadTokens ?? 0,
      cacheCreationTokens: entry.cacheCreationTokens ?? 0,
      costUsd: typeof entry.costUsd === "number" ? entry.costUsd : null,
    })),
  };
}

/** Appends one turn. Best-effort: a lost record must never fail the turn. */
export async function appendUsage(path, record) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    await rotate(path);
  } catch {
    /* Best effort. */
  }
}

async function rotate(path) {
  try {
    const info = await stat(path);
    if (info.size <= MAX_BYTES) return;
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    await writeFile(path, `${lines.slice(-KEEP_LINES).join("\n")}\n`, "utf8");
    await rename(path, path).catch(() => {});
  } catch {
    /* Best effort. */
  }
}

export async function readUsage(path) {
  try {
    const text = await readFile(path, "utf8");
    const records = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // One corrupt line must not discard the rest of the ledger.
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** Local calendar day, so "today" means the operator's today. */
function dayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyBucket() {
  return { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, turns: 0, costReported: false };
}

function add(bucket, record, tokens = record.total, cost = record.costUsd) {
  bucket.tokens += tokens;
  bucket.input += record.tokens?.input ?? 0;
  bucket.output += record.tokens?.output ?? 0;
  bucket.cacheRead += record.tokens?.cacheRead ?? 0;
  bucket.cacheCreation += record.tokens?.cacheCreation ?? 0;
  bucket.turns += 1;
  if (typeof cost === "number") {
    bucket.costUsd += cost;
    bucket.costReported = true;
  }
}

/**
 * The dashboard's whole answer, in one pass.
 *
 * `days` is inclusive of today and always fully populated — a day with no turns
 * is a zero row, not a gap. A bar chart that silently drops empty days
 * compresses the axis and makes a quiet week look like a busy one.
 */
export async function summariseUsage(path, { days = 7, now = new Date() } = {}) {
  const records = await readUsage(path);

  const dayKeys = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    dayKeys.push(dayKey(date.toISOString()));
  }
  const window = new Set(dayKeys);

  const byDay = new Map(dayKeys.map((key) => [key, emptyBucket()]));
  const byModel = new Map();
  const byEngine = new Map();
  const overall = emptyBucket();

  for (const record of records) {
    const key = dayKey(record.at);
    if (!key || !window.has(key)) continue;

    add(byDay.get(key), record);
    add(overall, record);

    if (!byEngine.has(record.engine)) byEngine.set(record.engine, emptyBucket());
    add(byEngine.get(record.engine), record);

    // Per model. A turn that named its models is attributed to each of them;
    // one that did not is attributed to whatever it was asked to run, so no
    // turn's tokens go missing from the per-model view.
    const breakdown = record.models?.length
      ? record.models
      : [{
          id: record.model ?? record.engine,
          inputTokens: record.tokens?.input ?? 0,
          outputTokens: record.tokens?.output ?? 0,
          cacheReadTokens: record.tokens?.cacheRead ?? 0,
          cacheCreationTokens: record.tokens?.cacheCreation ?? 0,
          costUsd: record.costUsd,
        }];

    for (const entry of breakdown) {
      const id = entry.id ?? record.engine;
      if (!byModel.has(id)) byModel.set(id, { ...emptyBucket(), engine: record.engine });
      const bucket = byModel.get(id);
      const tokens = record.models?.length
        ? (entry.inputTokens ?? 0) +
          (entry.outputTokens ?? 0) +
          (entry.cacheReadTokens ?? 0) +
          (entry.cacheCreationTokens ?? 0)
        : record.total;
      add(bucket, record, tokens, entry.costUsd);
    }
  }

  const activeDays = dayKeys.filter((key) => byDay.get(key).turns > 0).length;

  return {
    days,
    generatedAt: now.toISOString(),
    totals: overall,
    // Two averages, because they answer different questions: "per day" spreads
    // across the whole window including idle days, "per active day" describes a
    // day you actually worked. Reporting only the first makes a heavy Tuesday
    // look like a light week.
    average: {
      perDay: {
        tokens: overall.tokens / days,
        costUsd: overall.costUsd / days,
      },
      perActiveDay: {
        tokens: activeDays ? overall.tokens / activeDays : 0,
        costUsd: activeDays ? overall.costUsd / activeDays : 0,
      },
      activeDays,
    },
    daily: dayKeys.map((key) => ({ day: key, ...byDay.get(key) })),
    models: [...byModel.entries()]
      .map(([id, bucket]) => ({ id, ...bucket }))
      .sort((a, b) => b.tokens - a.tokens),
    engines: [...byEngine.entries()].map(([id, bucket]) => ({ id, ...bucket })),
  };
}
