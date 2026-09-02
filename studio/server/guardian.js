/**
 * Guardian — what this machine is actually doing, right now.
 *
 * The point of this module is the thing a model runner needs and almost never
 * has: an honest answer to "what is resident in memory at this instant, and
 * what is competing with it". Ollama will happily keep a 14B model wired for
 * five minutes after the last token, and the operator has no way to see that
 * from the chat window — the machine just feels slow.
 *
 * Two rules govern everything below.
 *
 *   1. **Every number is measured or it is null.** There is no fallback that
 *      guesses, no "approximately", no default that looks like data. A metric
 *      we could not read is reported as null and listed in `unavailable` with
 *      the reason, so the interface can say "not measurable" rather than
 *      draw a plausible-looking zero.
 *   2. **Nothing shells through a shell.** Every subprocess is execFile with an
 *      argument array. Model names arrive from the network and a `;` in one
 *      must be an invalid model name, not a command separator.
 *
 * `powermetrics` is deliberately absent. It is the only source for real
 * per-package power draw and GPU residency on Apple Silicon, and it requires
 * root — a desktop app that prompts for a sudo password to draw a dial is
 * doing something wrong. The metrics it would have provided are declared
 * unavailable with that reason attached.
 *
 * The parsers are pure and exported separately from the code that shells out,
 * so tests/guardian.test.mjs can drive them from captured fixture output
 * instead of from whatever the test machine happens to be doing.
 */

import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DEFAULT_GOVERNOR_SETTINGS } from "./guardian-governor.js";

const run = promisify(execFile);

const EXEC_TIMEOUT_MS = 4_000;
/** system_profiler takes the better part of a second; battery health does not change that fast. */
const POWER_PROFILE_TTL_MS = 300_000;
const OLLAMA_TIMEOUT_MS = 2_500;
/** Ollama acknowledges an unload before the runner has released the memory. */
const UNLOAD_CONFIRM_ATTEMPTS = 6;
const UNLOAD_CONFIRM_INTERVAL_MS = 250;
/** A CPU delta older than this describes the past, not the present. */
const CPU_SAMPLE_MAX_AGE_MS = 30_000;
const CPU_SAMPLE_WINDOW_MS = 200;

/* ── Pure parsers ─────────────────────────────────────────────────────────── */

/**
 * `vm_stat` reports page counts, not bytes, against a page size it prints in
 * its own header — 16KB on Apple Silicon, 4KB on Intel. Reading the header
 * rather than assuming a constant is the difference between a correct figure
 * and one that is wrong by 4x.
 */
export function parseVmStat(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const header = /page size of (\d+) bytes/.exec(text);
  if (!header) return null;

  const pages = {};
  const KEYS = {
    "Pages free": "free",
    "Pages active": "active",
    "Pages inactive": "inactive",
    "Pages speculative": "speculative",
    "Pages throttled": "throttled",
    "Pages wired down": "wired",
    "Pages purgeable": "purgeable",
    "Pages stored in compressor": "compressorStored",
    "Pages occupied by compressor": "compressorOccupied",
    "File-backed pages": "fileBacked",
    "Anonymous pages": "anonymous",
  };
  for (const line of text.split("\n")) {
    const row = /^(.+?):\s+(\d+)\.?\s*$/.exec(line.trim());
    if (!row) continue;
    const key = KEYS[row[1]];
    if (key) pages[key] = Number(row[2]);
  }
  return { pageSizeBytes: Number(header[1]), pages };
}

/**
 * Turn page counts into the breakdown Activity Monitor shows.
 *
 * "Available" is free + speculative + purgeable + inactive, because inactive
 * pages are file-backed and reclaimable without touching swap. Reporting only
 * `free` is how a Mac with 12GB of reclaimable cache gets described as being
 * out of memory.
 */
export function memoryFromVmStat(vmStat, totalBytes) {
  if (!vmStat || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const { pageSizeBytes, pages } = vmStat;
  const bytes = (count) => (Number.isFinite(pages[count]) ? pages[count] * pageSizeBytes : 0);

  const free = bytes("free") + bytes("speculative");
  const active = bytes("active");
  const inactive = bytes("inactive");
  const wired = bytes("wired");
  const purgeable = bytes("purgeable");
  const compressed = bytes("compressorOccupied");

  const available = free + purgeable + inactive;
  const used = Math.max(0, totalBytes - available);

  return {
    totalBytes,
    freeBytes: free,
    activeBytes: active,
    inactiveBytes: inactive,
    wiredBytes: wired,
    purgeableBytes: purgeable,
    compressedBytes: compressed,
    availableBytes: available,
    usedBytes: used,
    usedPercent: round1((used / totalBytes) * 100),
    availablePercent: round1((available / totalBytes) * 100),
    pageSizeBytes,
  };
}

/** `sysctl -n vm.swapusage` → `total = 5120.00M  used = 3700.62M  free = 1419.38M  (encrypted)` */
export function parseSwapUsage(text) {
  if (typeof text !== "string") return null;
  const field = (name) => {
    const match = new RegExp(`${name}\\s*=\\s*([\\d.]+)([KMGT])`, "i").exec(text);
    if (!match) return null;
    const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2].toUpperCase()];
    return Math.round(Number(match[1]) * scale);
  };
  const totalBytes = field("total");
  const usedBytes = field("used");
  if (totalBytes === null || usedBytes === null) return null;
  return {
    totalBytes,
    usedBytes,
    freeBytes: field("free"),
    encrypted: /\(encrypted\)/.test(text),
    usedPercent: totalBytes > 0 ? round1((usedBytes / totalBytes) * 100) : 0,
  };
}

/**
 * The kernel's own verdict, from `kern.memorystatus_vm_pressure_level`. This is
 * the same signal `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` delivers to apps, so it
 * beats any threshold we could invent over the used-percentage.
 */
export function parsePressureLevel(raw) {
  const level = Number(String(raw ?? "").trim());
  if (level === 1) return "normal";
  if (level === 2) return "warning";
  if (level === 4) return "critical";
  return null;
}

/** `pmset -g batt` — power source, charge, and time remaining when the OS has an estimate. */
export function parseBattery(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const sourceMatch = /Now drawing from '([^']+)'/.exec(text);
  const source = sourceMatch ? sourceMatch[1] : null;

  const percentMatch = /(\d+)%/.exec(text);
  const stateMatch = /%;\s*([a-zA-Z ]+?);/.exec(text);
  const remainingMatch = /(\d+):(\d{2})\s+remaining/.exec(text);
  const minutes = remainingMatch ? Number(remainingMatch[1]) * 60 + Number(remainingMatch[2]) : null;

  return {
    source,
    onBattery: source !== null && !/AC Power/i.test(source),
    percent: percentMatch ? Number(percentMatch[1]) : null,
    state: stateMatch ? stateMatch[1].trim() : null,
    // macOS prints 0:00 while it recalculates; that is "unknown", not "empty".
    minutesRemaining: minutes && minutes > 0 ? minutes : null,
    present: /present:\s*true/.test(text),
  };
}

/**
 * `pmset -g therm` is the only thermal signal available without root.
 *
 * On a cool machine it prints "no ... has been recorded", which is genuinely
 * different from "100% and fine" — the OS has simply never had cause to write
 * a value. `recorded: false` preserves that distinction instead of flattening
 * it to a reassuring 100.
 */
export function parseThermal(text) {
  if (typeof text !== "string") return null;
  const number = (label) => {
    const match = new RegExp(`${label}\\s*=\\s*(\\d+)`).exec(text);
    return match ? Number(match[1]) : null;
  };
  const cpuSpeedLimitPercent = number("CPU_Speed_Limit");
  const schedulerLimitPercent = number("CPU_Scheduler_Limit");
  const availableCpus = number("CPU_Available_CPUs");
  const recorded = cpuSpeedLimitPercent !== null || schedulerLimitPercent !== null || availableCpus !== null;

  return {
    recorded,
    cpuSpeedLimitPercent,
    schedulerLimitPercent,
    availableCpus,
    note: recorded ? null : "macOS has not recorded a thermal or performance warning level on this boot.",
  };
}

/** `df -k <mount>` — 1024-byte blocks, header row then one filesystem row. */
export function parseDiskFree(text) {
  if (typeof text !== "string") return null;
  const rows = text.trim().split("\n");
  if (rows.length < 2) return null;
  const columns = rows[rows.length - 1].trim().split(/\s+/);
  if (columns.length < 6) return null;
  const block = 1024;
  const totalBytes = Number(columns[1]) * block;
  const usedBytes = Number(columns[2]) * block;
  const freeBytes = Number(columns[3]) * block;
  if (![totalBytes, usedBytes, freeBytes].every(Number.isFinite)) return null;
  return {
    mount: columns[columns.length - 1],
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: totalBytes > 0 ? round1((usedBytes / totalBytes) * 100) : null,
  };
}

/**
 * A macOS executable path is not a name a human recognises: the thing eating
 * 4GB is "Cursor", not ".../Cursor Helper (Renderer).app/Contents/MacOS/...".
 * Collapsing to the bundle name is what makes the process list scannable.
 */
export function displayNameForCommand(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  const bundle = /\/([^/]+)\.app\//.exec(command);
  if (bundle) {
    // Helpers belong to their host app; "Cursor Helper (Renderer)" reads as Cursor.
    const helper = /^(.*?)\s+Helper(\s*\(.*\))?$/.exec(bundle[1]);
    return helper ? helper[1] : bundle[1];
  }
  return command.split("/").pop() || command;
}

/**
 * `ps -Ao pid=,rss=,pcpu=,comm=` — RSS in kilobytes, %CPU relative to one core.
 *
 * That %CPU is the kernel's decayed usage average, the same figure `top`
 * shows, not an instantaneous reading; it is reported as-is and named
 * `cpuPercent` rather than dressed up as something sharper than it is.
 */
export function parseProcessList(text, totalMemoryBytes = null) {
  if (typeof text !== "string") return [];
  const processes = [];
  for (const line of text.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*\S)\s*$/.exec(line);
    if (!row) continue;
    const pid = Number(row[1]);
    if (pid === 0) continue;
    const rssBytes = Number(row[2]) * 1024;
    const command = row[4];
    processes.push({
      pid,
      rssBytes,
      cpuPercent: Number(row[3]),
      command,
      name: displayNameForCommand(command),
      memoryPercent:
        Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0
          ? round1((rssBytes / totalMemoryBytes) * 100)
          : null,
    });
  }
  return processes;
}

/**
 * Several helper processes of one app each hold a slice of the same working
 * set; ten Chrome renderers at 400MB is one 4GB answer, not ten small ones.
 */
export function groupProcessesByApp(processes) {
  const groups = new Map();
  for (const process of processes) {
    const key = process.name ?? String(process.pid);
    const existing = groups.get(key);
    if (existing) {
      existing.rssBytes += process.rssBytes;
      existing.cpuPercent = round1(existing.cpuPercent + process.cpuPercent);
      existing.processCount += 1;
      if (process.rssBytes > existing.largestRssBytes) {
        existing.largestRssBytes = process.rssBytes;
        existing.pid = process.pid;
      }
    } else {
      groups.set(key, {
        name: key,
        pid: process.pid,
        rssBytes: process.rssBytes,
        largestRssBytes: process.rssBytes,
        cpuPercent: process.cpuPercent,
        processCount: 1,
      });
    }
  }
  return [...groups.values()];
}

/* ── CPU ──────────────────────────────────────────────────────────────────── */

/** A cumulative snapshot of per-core kernel time counters. Meaningless alone. */
export function sampleCpuTimes(cpus = os.cpus()) {
  return { at: Date.now(), cores: cpus.map((core) => ({ ...core.times })) };
}

/**
 * Utilisation is a delta between two samples — there is no such thing as an
 * instantaneous reading of a cumulative counter, so a single sample yields
 * null rather than a number derived from uptime-long averages.
 */
export function cpuUtilisation(previous, next) {
  if (!previous || !next) return null;
  if (previous.cores.length !== next.cores.length || previous.cores.length === 0) return null;
  const elapsedMs = next.at - previous.at;
  if (elapsedMs <= 0) return null;

  const perCore = [];
  let busy = 0;
  let total = 0;
  for (let index = 0; index < next.cores.length; index += 1) {
    const before = previous.cores[index];
    const after = next.cores[index];
    const coreTotal = ["user", "nice", "sys", "irq", "idle"].reduce(
      (sum, key) => sum + ((after[key] ?? 0) - (before[key] ?? 0)),
      0,
    );
    const coreIdle = (after.idle ?? 0) - (before.idle ?? 0);
    if (coreTotal <= 0) {
      perCore.push(null);
      continue;
    }
    perCore.push(round1(((coreTotal - coreIdle) / coreTotal) * 100));
    busy += coreTotal - coreIdle;
    total += coreTotal;
  }
  if (total <= 0) return null;
  return { percent: round1((busy / total) * 100), perCore, windowMs: elapsedMs };
}

/* ── Ollama residency ─────────────────────────────────────────────────────── */

/**
 * `/api/ps` is the headline: not what is installed, but what is wired into
 * memory this second. `size_vram` is what the GPU actually holds — on Apple
 * Silicon that is unified memory, so it is competing with every other app on
 * the machine, which is exactly why it belongs next to the memory figures.
 */
export function normaliseResidentModels(payload, nowMs = Date.now()) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models
    .filter((model) => typeof model?.name === "string")
    .map((model) => {
      const expiresAtMs = model.expires_at ? Date.parse(model.expires_at) : NaN;
      return {
        name: model.name,
        digest: typeof model.digest === "string" ? model.digest : null,
        sizeBytes: Number.isFinite(model.size) ? model.size : null,
        vramBytes: Number.isFinite(model.size_vram) ? model.size_vram : null,
        contextLength: Number.isFinite(model.context_length) ? model.context_length : null,
        parameterSize: model.details?.parameter_size ?? null,
        quantization: model.details?.quantization_level ?? null,
        family: model.details?.family ?? null,
        expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
        // Negative means Ollama is holding it past its own deadline, which it
        // does briefly while a request is in flight.
        expiresInSeconds: Number.isFinite(expiresAtMs) ? Math.round((expiresAtMs - nowMs) / 1000) : null,
      };
    });
}

/**
 * How long a resident model has been idle.
 *
 * Ollama does not report last-use time. It does push `expires_at` forward on
 * every request, so an expiry that has not moved since we last looked is a
 * model that has not been touched since then. That gives a *lower bound* on
 * idle time — never an upper one — and the flag says so, because claiming
 * "idle 12 minutes" when the process only started watching 3 minutes ago
 * would be exactly the kind of invented number this module exists to avoid.
 */
export function trackResidency(registry, models, nowMs = Date.now()) {
  const next = new Map();
  const tracked = models.map((model) => {
    const previous = registry?.get(model.name);
    const expiryAdvanced = !previous || (model.expiresAtMs ?? 0) > (previous.expiresAtMs ?? 0);
    const entry = {
      expiresAtMs: model.expiresAtMs,
      // First sighting anchors both clocks; we cannot know when it loaded.
      lastAdvancedAtMs: expiryAdvanced ? nowMs : previous.lastAdvancedAtMs,
      firstSeenAtMs: previous?.firstSeenAtMs ?? nowMs,
    };
    next.set(model.name, entry);
    const idleMs = nowMs - entry.lastAdvancedAtMs;
    return {
      ...model,
      idleSeconds: Math.max(0, Math.round(idleMs / 1000)),
      // True until we have actually seen the expiry move at least once.
      idleIsLowerBound: entry.lastAdvancedAtMs === entry.firstSeenAtMs,
      observedForSeconds: Math.max(0, Math.round((nowMs - entry.firstSeenAtMs) / 1000)),
    };
  });
  return { registry: next, models: tracked };
}

/* ── Advice ───────────────────────────────────────────────────────────────── */

/**
 * Idle long enough that unloading is a suggestion rather than a nuisance.
 *
 * Only the fallback: the operator's `unloadIdleModelsAfterMinutes` governs when
 * settings are supplied, so the advice you read and the sweep that acts are
 * answering to the same number.
 */
const IDLE_UNLOAD_SECONDS = 180;
/** Below this much reclaimable memory, starting another model will swap. */
const TIGHT_HEADROOM_BYTES = 3 * 1024 ** 3;
/** A process this large is worth naming when memory is the problem. */
const NOTABLE_PROCESS_BYTES = 2 * 1024 ** 3;

/**
 * The advice layer, ported in spirit from apex_guardian's optimizer_engine but
 * inverted: that one acted on the machine (renice, purge, kill). This one only
 * observes, and every observation carries the measurements it was drawn from —
 * so the operator can disagree with the conclusion while still trusting the
 * evidence. Nothing here mutates anything; the single action offered is an
 * explicit unload the operator clicks.
 */
export function buildAdvice(snapshot, settings = null) {
  const advice = [];
  const { memory, swap, ollama, processes, power, thermal, cpu } = snapshot;
  const resident = ollama?.residentModels ?? [];

  const configuredIdleMinutes = Number(settings?.unloadIdleModelsAfterMinutes);
  const idleUnloadSeconds = Number.isFinite(configuredIdleMinutes) && configuredIdleMinutes > 0
    ? configuredIdleMinutes * 60
    : IDLE_UNLOAD_SECONDS;

  /* Swap while models are resident is the worst state to be in: the model is
     nominally "in memory" but pages of it are on disk, and every token pays. */
  if (swap?.usedBytes > 0 && resident.length > 0) {
    advice.push({
      id: "swap-under-model",
      severity: swap.usedBytes > 2 * 1024 ** 3 ? "critical" : "warning",
      title: "Swap is in use while a model is resident",
      detail:
        `Close something before starting another model — pages of ${resident.length === 1 ? "it" : "them"} ` +
        "may already be on disk, and every token pays for the fault.",
      evidence: [
        `swap used ${gb(swap.usedBytes)} of ${gb(swap.totalBytes)}`,
        `${resident.length} model${resident.length === 1 ? "" : "s"} resident, ${gb(sumVram(resident))} wired`,
      ],
    });
  } else if (swap?.usedBytes > 1024 ** 3) {
    advice.push({
      id: "swap-in-use",
      severity: "warning",
      title: "Swap is being used",
      detail: "Free memory before loading a large model, or it will start life partly on disk.",
      evidence: [`swap used ${gb(swap.usedBytes)} of ${gb(swap.totalBytes)}`],
    });
  }

  /* The headline suggestion: a model nobody is talking to, holding GBs. */
  for (const model of resident) {
    if (model.idleSeconds >= idleUnloadSeconds && model.vramBytes) {
      advice.push({
        id: `idle-model:${model.name}`,
        severity: memory?.pressure === "normal" ? "info" : "warning",
        title: `${model.name} is resident and idle`,
        detail: `Unloading frees ${gb(model.vramBytes)}.`,
        evidence: [
          `idle ${minutes(model.idleSeconds)}${model.idleIsLowerBound ? " or more (watched for " + minutes(model.observedForSeconds) + ")" : ""}`,
          `${gb(model.vramBytes)} wired in unified memory`,
          model.expiresInSeconds !== null ? `Ollama unloads it on its own in ${minutes(model.expiresInSeconds)}` : null,
        ].filter(Boolean),
        action: { kind: "unload", model: model.name },
      });
    }
  }

  /* More than one resident model is nearly always accidental — a model switch
     mid-session leaves the previous one wired for the rest of its keep_alive. */
  if (resident.length > 1) {
    advice.push({
      id: "multiple-resident",
      severity: "warning",
      title: `${resident.length} models are resident at once`,
      detail: "A mid-session model switch leaves the previous one wired until its keep-alive expires.",
      evidence: [
        `${gb(sumVram(resident))} wired in total`,
        resident.map((model) => `${model.name} ${gb(model.vramBytes)}`).join(", "),
      ],
    });
  }

  if (memory?.pressure === "critical" || memory?.pressure === "warning") {
    advice.push({
      id: "memory-pressure",
      severity: memory.pressure === "critical" ? "critical" : "warning",
      title: `The kernel reports ${memory.pressure} memory pressure`,
      detail: "This is macOS's own signal, not a threshold this app invented.",
      evidence: [
        `kern.memorystatus_vm_pressure_level = ${memory.pressure}`,
        `${gb(memory.availableBytes)} available of ${gb(memory.totalBytes)}`,
      ],
    });
  }

  /* Headroom against the largest thing already loaded: if the biggest resident
     model would not fit in what is left, a second one certainly will not. */
  const headroomKnown = Number.isFinite(memory?.availableBytes);
  if (headroomKnown && memory.availableBytes < TIGHT_HEADROOM_BYTES) {
    const largest = resident.reduce((best, model) => (model.vramBytes > (best?.vramBytes ?? 0) ? model : best), null);
    advice.push({
      id: "tight-headroom",
      severity: "warning",
      title: "Not enough headroom for another model",
      detail: largest
        ? `${gb(memory.availableBytes)} free would not hold another ${largest.name} (${gb(largest.vramBytes)}).`
        : `${gb(memory.availableBytes)} free is below what any mid-size model needs.`,
      evidence: [
        `${gb(memory.availableBytes)} available (free + purgeable + inactive)`,
        `${memory.usedPercent}% of ${gb(memory.totalBytes)} in use`,
      ],
    });
  }

  /* Name what is competing, but only when memory is actually the problem —
     otherwise this is just a list of the apps the operator chose to open. */
  const contested =
    (memory?.pressure && memory.pressure !== "normal") ||
    (headroomKnown && memory.availableBytes < TIGHT_HEADROOM_BYTES);
  const biggest = processes?.byMemory?.find(
    (process) => process.rssBytes >= NOTABLE_PROCESS_BYTES && !/ollama/i.test(process.name ?? ""),
  );
  if (contested && biggest) {
    advice.push({
      id: `competing:${biggest.name}`,
      severity: "info",
      title: `${biggest.name} is the largest non-model process`,
      detail: "Quitting it is the cheapest way to make room without unloading a model.",
      evidence: [
        `${gb(biggest.rssBytes)} resident across ${biggest.processCount} process${biggest.processCount === 1 ? "" : "es"}`,
        biggest.memoryPercent !== null ? `${biggest.memoryPercent}% of physical memory` : null,
      ].filter(Boolean),
    });
  }

  if (power?.onBattery && resident.length > 0) {
    advice.push({
      id: "on-battery",
      severity: "info",
      title: "Running a resident model on battery",
      detail: "Sustained inference is the heaviest continuous load this machine can draw.",
      evidence: [
        `power source ${power.source}`,
        power.percent !== null ? `battery ${power.percent}%` : null,
        power.minutesRemaining ? `${minutes(power.minutesRemaining * 60)} estimated remaining` : null,
      ].filter(Boolean),
    });
  }

  if (thermal?.recorded && thermal.cpuSpeedLimitPercent !== null && thermal.cpuSpeedLimitPercent < 100) {
    advice.push({
      id: "thermal-throttle",
      severity: "warning",
      title: "The CPU is being speed-limited",
      detail: "Tokens per second will be below this machine's normal rate until it cools.",
      evidence: [`pmset reports CPU_Speed_Limit = ${thermal.cpuSpeedLimitPercent}%`],
    });
  }

  /* Load average above core count means work is queueing, which shows up as
     latency before the first token far more than as slow generation. */
  const load1 = snapshot.load?.[0];
  if (Number.isFinite(load1) && cpu?.cores && load1 > cpu.cores) {
    advice.push({
      id: "run-queue",
      severity: "info",
      title: "More runnable work than cores",
      detail: "Expect a longer wait before the first token; generation itself is memory-bound.",
      evidence: [`1-minute load average ${load1.toFixed(2)} across ${cpu.cores} cores`],
    });
  }

  if (!headroomKnown) {
    advice.push({
      id: "memory-unmeasured",
      severity: "info",
      title: "Memory could not be measured",
      detail: "Residency figures are still accurate; the headroom advice below is suspended.",
      evidence: ["vm_stat did not return a parseable breakdown — see the unavailable metrics"],
    });
  }

  if (advice.length === 0) {
    advice.push({
      id: "clear",
      severity: "info",
      title: "Nothing competing for memory",
      detail: resident.length
        ? "Resident models fit comfortably in what is free."
        : "No model is resident; the next one starts from a cold load.",
      evidence: [
        memory ? `${gb(memory.availableBytes)} available of ${gb(memory.totalBytes)}` : null,
        swap ? `swap used ${gb(swap.usedBytes)}` : null,
      ].filter(Boolean),
    });
  }

  return advice;
}

/* ── Shelling out ─────────────────────────────────────────────────────────── */

/** Every subprocess funnels through here so no call site can pass a shell string. */
async function exec(file, args, timeout = EXEC_TIMEOUT_MS) {
  const { stdout } = await run(file, args, { timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function attempt(file, args, timeout) {
  try {
    return { ok: true, stdout: await exec(file, args, timeout) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* Module-level caches. Both exist to avoid paying for a slow or delta-based
   measurement on every poll; neither ever substitutes a stale value silently. */
let lastCpuSample = null;
let residencyRegistry = new Map();
let powerProfileCache = { at: 0, value: null };

async function readCpu() {
  const now = sampleCpuTimes();
  const fresh = lastCpuSample && now.at - lastCpuSample.at <= CPU_SAMPLE_MAX_AGE_MS;
  if (fresh) {
    const utilisation = cpuUtilisation(lastCpuSample, now);
    lastCpuSample = now;
    if (utilisation) return utilisation;
  }
  // Nothing recent to diff against, so measure a real short window rather than
  // reporting the since-boot average as if it were the present.
  await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_WINDOW_MS));
  const second = sampleCpuTimes();
  const utilisation = cpuUtilisation(now, second);
  lastCpuSample = second;
  return utilisation;
}

/** Battery health, which system_profiler alone knows and takes ~1s to say. */
async function readPowerProfile(nowMs) {
  if (powerProfileCache.value && nowMs - powerProfileCache.at < POWER_PROFILE_TTL_MS) {
    return powerProfileCache.value;
  }
  const result = await attempt("system_profiler", ["SPPowerDataType", "-json"], 8_000);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const battery = parsed?.SPPowerDataType?.find((entry) => entry?._name === "spbattery_information");
    const health = battery?.sppower_battery_health_info ?? {};
    const value = {
      cycleCount: Number.isFinite(health.sppower_battery_cycle_count) ? health.sppower_battery_cycle_count : null,
      health: typeof health.sppower_battery_health === "string" ? health.sppower_battery_health : null,
      maximumCapacityPercent: parsePercent(health.sppower_battery_health_maximum_capacity),
    };
    powerProfileCache = { at: nowMs, value };
    return value;
  } catch {
    return null;
  }
}

async function readOllama(ollamaUrl, fetchImpl) {
  const url = new URL("api/ps", ollamaUrl.endsWith("/") ? ollamaUrl : `${ollamaUrl}/`).toString();
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
    if (!response.ok) {
      return { reachable: false, url, residentModels: [], error: `Ollama returned HTTP ${response.status}.` };
    }
    return { reachable: true, url, payload: await response.json(), error: null };
  } catch (error) {
    return {
      reachable: false,
      url,
      residentModels: [],
      error: error instanceof Error ? error.message : "Ollama is not reachable.",
    };
  }
}

/**
 * One telemetry snapshot.
 *
 * Every probe runs concurrently and every one is allowed to fail on its own:
 * a machine without `pmset` still gets memory and process figures, and the
 * missing metric names itself in `unavailable` rather than disappearing.
 */
export async function guardianSnapshot({
  ollamaUrl = "http://127.0.0.1:11434",
  fetchImpl = fetch,
  processLimit = 6,
  mount = "/",
  settings = DEFAULT_GOVERNOR_SETTINGS,
} = {}) {
  const nowMs = Date.now();
  const platform = process.platform;
  const unavailable = [];
  const totalMemoryBytes = os.totalmem();
  const cores = os.cpus().length;

  const darwin = platform === "darwin";

  const [vmStatResult, swapResult, pressureResult, battResult, thermResult, diskResult, psResult, cpu, ollamaRaw] =
    await Promise.all([
      darwin ? attempt("vm_stat", []) : { ok: false, error: "vm_stat is macOS-only." },
      darwin ? attempt("sysctl", ["-n", "vm.swapusage"]) : { ok: false, error: "vm.swapusage is macOS-only." },
      darwin
        ? attempt("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])
        : { ok: false, error: "Kernel memory pressure is macOS-only." },
      darwin ? attempt("pmset", ["-g", "batt"]) : { ok: false, error: "pmset is macOS-only." },
      darwin ? attempt("pmset", ["-g", "therm"]) : { ok: false, error: "pmset is macOS-only." },
      attempt("df", ["-k", mount]),
      attempt("ps", ["-Ao", "pid=,rss=,pcpu=,comm="]),
      readCpu(),
      readOllama(ollamaUrl, fetchImpl),
    ]);

  /* Memory. On macOS os.freemem() reports only genuinely free pages, which on a
     warm Mac is always near zero and always misleading, so vm_stat is the
     source and os.totalmem() only supplies the denominator. */
  let memory = null;
  if (vmStatResult.ok) {
    memory = memoryFromVmStat(parseVmStat(vmStatResult.stdout), totalMemoryBytes);
  }
  if (!memory) {
    unavailable.push({
      metric: "memory.breakdown",
      reason: vmStatResult.ok ? "vm_stat output could not be parsed." : vmStatResult.error,
    });
    memory = { totalBytes: totalMemoryBytes, freeBytes: os.freemem(), availableBytes: null, usedBytes: null, usedPercent: null, pressure: null };
  } else {
    memory.pressure = pressureResult.ok ? parsePressureLevel(pressureResult.stdout) : null;
    if (memory.pressure === null) {
      unavailable.push({
        metric: "memory.pressure",
        reason: pressureResult.ok
          ? "kern.memorystatus_vm_pressure_level returned an unrecognised level."
          : pressureResult.error,
      });
    }
  }

  const swap = swapResult.ok ? parseSwapUsage(swapResult.stdout) : null;
  if (!swap) unavailable.push({ metric: "swap", reason: swapResult.ok ? "vm.swapusage could not be parsed." : swapResult.error });

  const battery = battResult.ok ? parseBattery(battResult.stdout) : null;
  if (!battery) unavailable.push({ metric: "power.battery", reason: battResult.ok ? "pmset -g batt could not be parsed." : battResult.error });

  const thermal = thermResult.ok ? parseThermal(thermResult.stdout) : null;
  if (!thermal) unavailable.push({ metric: "thermal", reason: thermResult.ok ? "pmset -g therm could not be parsed." : thermResult.error });

  const disk = diskResult.ok ? parseDiskFree(diskResult.stdout) : null;
  if (!disk) unavailable.push({ metric: "disk", reason: diskResult.ok ? "df output could not be parsed." : diskResult.error });

  if (!cpu) unavailable.push({ metric: "cpu.utilisation", reason: "Two CPU time samples could not be compared." });

  // The honest note about the one thing worth having that we will not take.
  if (darwin) {
    unavailable.push({
      metric: "gpu.residency,power.packageWatts",
      reason: "powermetrics is the only source and it requires root; the app will not prompt for sudo to draw a dial.",
    });
  }

  /* Processes: two orderings of one measurement, so the operator can ask both
     "what is holding memory" and "what is burning CPU" without a second call. */
  let processes = { byMemory: [], byCpu: [], total: null };
  if (psResult.ok) {
    const raw = parseProcessList(psResult.stdout, totalMemoryBytes);
    const grouped = groupProcessesByApp(raw).map((group) => ({
      ...group,
      memoryPercent: totalMemoryBytes > 0 ? round1((group.rssBytes / totalMemoryBytes) * 100) : null,
    }));
    processes = {
      total: raw.length,
      byMemory: [...grouped].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, processLimit),
      byCpu: [...grouped].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, processLimit),
    };
  } else {
    unavailable.push({ metric: "processes", reason: psResult.error });
  }

  /* Ollama residency, plus the idle clock we can only keep by watching. */
  let ollama = { reachable: false, url: ollamaRaw.url, residentModels: [], totalVramBytes: 0, error: ollamaRaw.error };
  if (ollamaRaw.reachable) {
    const models = normaliseResidentModels(ollamaRaw.payload, nowMs);
    const tracked = trackResidency(residencyRegistry, models, nowMs);
    residencyRegistry = tracked.registry;
    ollama = {
      reachable: true,
      url: ollamaRaw.url,
      residentModels: tracked.models,
      totalVramBytes: sumVram(tracked.models),
      error: null,
    };
  } else {
    // Forget the idle clocks; on reconnect we are watching fresh, not resuming.
    residencyRegistry = new Map();
    unavailable.push({ metric: "ollama.residentModels", reason: ollamaRaw.error });
  }

  const power = { ...(battery ?? { source: null, onBattery: null, percent: null, state: null, minutesRemaining: null, present: null }) };
  if (darwin && battery?.present) {
    const profile = await readPowerProfile(nowMs);
    if (profile) Object.assign(power, profile);
  }

  const snapshot = {
    capturedAt: new Date(nowMs).toISOString(),
    platform,
    host: {
      hostname: os.hostname(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: Math.round(os.uptime()),
    },
    cpu: { cores, ...(cpu ?? { percent: null, perCore: [], windowMs: null }) },
    load: os.loadavg(),
    memory,
    swap,
    thermal,
    power,
    disk,
    ollama,
    processes,
    unavailable,
  };
  snapshot.advice = buildAdvice(snapshot, settings);
  return snapshot;
}

/**
 * Unload one resident model.
 *
 * Ollama has no "unload" verb; a generate call with `keep_alive: 0` and no
 * prompt evicts the model and returns immediately. The name is checked against
 * what `/api/ps` currently reports rather than pattern-matched, which both
 * validates it and guarantees the reply describes something that was really
 * there — an unload of a model that was never resident is a lie, not a no-op.
 */
export async function unloadModel(name, { ollamaUrl = "http://127.0.0.1:11434", fetchImpl = fetch } = {}) {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) {
    throw Object.assign(new Error("A model name is required."), { status: 400, code: "MODEL_NAME_REQUIRED" });
  }

  const before = await readOllama(ollamaUrl, fetchImpl);
  if (!before.reachable) {
    throw Object.assign(new Error(before.error || "Ollama is not reachable."), {
      status: 503,
      code: "OLLAMA_UNREACHABLE",
    });
  }
  const resident = normaliseResidentModels(before.payload).find((model) => model.name === name);
  if (!resident) {
    throw Object.assign(new Error(`${name} is not resident in memory.`), { status: 409, code: "MODEL_NOT_RESIDENT" });
  }

  const base = ollamaUrl.endsWith("/") ? ollamaUrl : `${ollamaUrl}/`;
  const response = await fetchImpl(new URL("api/generate", base).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: name, keep_alive: 0 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Ollama refused the unload with HTTP ${response.status}.`), {
      status: 502,
      code: "UNLOAD_REJECTED",
    });
  }
  await response.text();

  /* Report what was actually freed, confirmed against /api/ps, not what we
     asked for. Ollama returns before the runner has finished releasing the
     memory — measured at under 250ms on this machine — so an immediate
     re-check reads the model as still resident and would report a successful
     unload as a failure. Poll instead of sleeping a fixed guess. */
  let stillResident = null;
  for (let attemptNumber = 0; attemptNumber < UNLOAD_CONFIRM_ATTEMPTS; attemptNumber += 1) {
    await new Promise((settle) => setTimeout(settle, UNLOAD_CONFIRM_INTERVAL_MS));
    const after = await readOllama(ollamaUrl, fetchImpl);
    if (!after.reachable) break;
    stillResident = normaliseResidentModels(after.payload).some((model) => model.name === name);
    if (!stillResident) break;
  }

  // A fresh residency map: the unloaded model's idle clock is meaningless now.
  residencyRegistry = new Map();

  return {
    model: name,
    unloaded: stillResident === false,
    freedBytes: stillResident === false ? resident.vramBytes : null,
    stillResident,
    detail:
      stillResident === false
        ? null
        : stillResident === true
          ? "Ollama accepted the request but the model is still resident; a request may be in flight."
          : "The unload was accepted but residency could not be re-checked.",
  };
}

/** Reset the watch state. Exists for tests; the idle clocks are process-local. */
export function resetGuardianState() {
  lastCpuSample = null;
  residencyRegistry = new Map();
  powerProfileCache = { at: 0, value: null };
}

/* ── Formatting helpers ───────────────────────────────────────────────────── */

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function sumVram(models) {
  return models.reduce((total, model) => total + (model.vramBytes ?? 0), 0);
}

function gb(bytes) {
  if (!Number.isFinite(bytes)) return "an unknown amount";
  return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;
}

function minutes(seconds) {
  if (!Number.isFinite(seconds)) return "an unknown time";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const whole = Math.round(seconds / 60);
  return whole < 60 ? `${whole} min` : `${(whole / 60).toFixed(1)}h`;
}

function parsePercent(value) {
  const match = /(\d+)\s*%/.exec(String(value ?? ""));
  return match ? Number(match[1]) : null;
}
