import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [action, manifestArg, runner, detail] = process.argv.slice(2);
if (!action || !manifestArg || !runner) {
  throw new Error(
    "usage: benchmark:002:clock -- start|accept-all|stop MANIFEST RUNNER [stop-reason]",
  );
}

const manifestPath = path.resolve(manifestArg);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!manifest.run_order.includes(runner)) {
  throw new Error(`unknown runner: ${runner}`);
}
const timingPath = path.resolve(manifest.timing_path);
const timing = JSON.parse(await readFile(timingPath, "utf8"));
const nowMonotonic = process.hrtime.bigint();
const nowIso = new Date().toISOString();
const record = timing.runs[runner] ?? { operator_actions: [] };

if (action === "start") {
  if (record.started_monotonic_ns) throw new Error(`${runner} timer already started`);
  record.started_monotonic_ns = nowMonotonic.toString();
  record.started_at = nowIso;
  record.operator_actions.push({ action: "prompt_submit", at: nowIso });
} else if (action === "accept-all") {
  if (!record.started_monotonic_ns || record.stopped_monotonic_ns) {
    throw new Error(`${runner} is not active`);
  }
  if (record.operator_actions.some((item) => item.action === "accept_all")) {
    throw new Error(`${runner} accept-all already recorded`);
  }
  record.operator_actions.push({ action: "accept_all", at: nowIso });
} else if (action === "stop") {
  if (!record.started_monotonic_ns) throw new Error(`${runner} timer not started`);
  if (record.stopped_monotonic_ns) throw new Error(`${runner} timer already stopped`);
  const allowedReasons = new Set(["completed", "time_limit", "product_terminated"]);
  if (!allowedReasons.has(detail)) {
    throw new Error("stop reason must be completed, time_limit, or product_terminated");
  }
  const started = BigInt(record.started_monotonic_ns);
  if (nowMonotonic < started) throw new Error("monotonic clock reset during run");
  record.stopped_monotonic_ns = nowMonotonic.toString();
  record.stopped_at = nowIso;
  record.elapsed_ms = Number(nowMonotonic - started) / 1_000_000;
  record.stop_reason = detail;
  record.operator_actions.push({ action: "stop", reason: detail, at: nowIso });
} else {
  throw new Error(`unknown clock action: ${action}`);
}

timing.runs[runner] = record;
await writeFile(timingPath, `${JSON.stringify(timing, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
