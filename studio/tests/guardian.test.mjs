import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdvice,
  cpuUtilisation,
  displayNameForCommand,
  groupProcessesByApp,
  memoryFromVmStat,
  normaliseResidentModels,
  parseBattery,
  parseDiskFree,
  parsePressureLevel,
  parseProcessList,
  parseSwapUsage,
  parseThermal,
  parseVmStat,
  trackResidency,
} from "../server/guardian.js";

const GB = 1024 ** 3;

/**
 * Every fixture below marked "captured" is verbatim output from the machine
 * this was developed on — an M4 Pro, 24GB, macOS 25.1 — taken while a real
 * Ollama model was resident. Parsers tested against invented output pass
 * against invented output; that is the whole failure mode this module exists
 * to avoid, so the strings are pasted rather than composed.
 */

/* ── vm_stat ──────────────────────────────────────────────────────────────── */

/** Captured: `vm_stat`. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               31431.
Pages active:                            504601.
Pages inactive:                          502824.
Pages speculative:                         5627.
Pages throttled:                              0.
Pages wired down:                        250127.
Pages purgeable:                          17909.
"Translation faults":                2049411301.
Pages copy-on-write:                   57138574.
Pages zero filled:                    678526014.
Pages reactivated:                    448067264.
Pages purged:                         106604078.
File-backed pages:                       317323.
Anonymous pages:                         695729.
Pages stored in compressor:              900339.
Pages occupied by compressor:            235473.
Decompressions:                       886571075.
Compressions:                         956998108.
Pageins:                              116551666.
Pageouts:                               1120215.
Swapins:                               47460414.
Swapouts:                              51887894.
`;

test("vm_stat page size is read from its own header, not assumed", () => {
  const parsed = parseVmStat(VM_STAT);
  // 16KB on Apple Silicon. Assuming the Intel 4KB would be wrong by 4x.
  assert.equal(parsed.pageSizeBytes, 16384);
  assert.equal(parsed.pages.free, 31431);
  assert.equal(parsed.pages.wired, 250127);
  assert.equal(parsed.pages.compressorOccupied, 235473);
});

test("vm_stat quoted and hyphenated rows do not derail the scan", () => {
  const parsed = parseVmStat(VM_STAT);
  // "Translation faults" is quoted and File-backed is hyphenated; neither is a
  // page-count we want, and neither may capture a key we do want.
  assert.equal(parsed.pages.fileBacked, 317323);
  assert.equal(parsed.pages.anonymous, 695729);
  assert.equal(Object.hasOwn(parsed.pages, "Translation faults"), false);
});

test("vm_stat without a page-size header yields null rather than a guess", () => {
  assert.equal(parseVmStat("Pages free: 100.\n"), null);
  assert.equal(parseVmStat(""), null);
  assert.equal(parseVmStat(undefined), null);
});

test("available memory counts purgeable and inactive, not just free", () => {
  const memory = memoryFromVmStat(parseVmStat(VM_STAT), 24 * GB);
  const page = 16384;
  const free = (31431 + 5627) * page;
  const expectedAvailable = free + 17909 * page + 502824 * page;
  assert.equal(memory.availableBytes, expectedAvailable);
  // Free alone is 565MB. Reporting that as "available" would describe a
  // perfectly healthy Mac as out of memory.
  assert.ok(memory.freeBytes < GB);
  assert.ok(memory.availableBytes > 8 * GB);
  assert.equal(memory.usedBytes, 24 * GB - expectedAvailable);
  assert.equal(memory.usedPercent, Math.round((memory.usedBytes / (24 * GB)) * 1000) / 10);
});

test("memory breakdown refuses to compute without a real total", () => {
  assert.equal(memoryFromVmStat(parseVmStat(VM_STAT), 0), null);
  assert.equal(memoryFromVmStat(null, 24 * GB), null);
});

/* ── Swap ─────────────────────────────────────────────────────────────────── */

/** Captured: `sysctl -n vm.swapusage`. */
const SWAPUSAGE = "total = 5120.00M  used = 3700.62M  free = 1419.38M  (encrypted)\n";

test("swap usage is scaled by the suffix macOS prints", () => {
  const swap = parseSwapUsage(SWAPUSAGE);
  assert.equal(swap.totalBytes, 5120 * 1024 ** 2);
  assert.equal(swap.usedBytes, Math.round(3700.62 * 1024 ** 2));
  assert.equal(swap.encrypted, true);
  assert.equal(swap.usedPercent, 72.3);
});

test("an unused swap file reports zero rather than nothing", () => {
  const swap = parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)");
  assert.equal(swap.usedBytes, 0);
  assert.equal(swap.usedPercent, 0);
});

test("unparseable swap output is null, not zero", () => {
  assert.equal(parseSwapUsage("sysctl: unknown oid"), null);
  assert.equal(parseSwapUsage(null), null);
});

/* ── Kernel memory pressure ───────────────────────────────────────────────── */

test("pressure maps the kernel's own levels and nothing else", () => {
  // Captured on an idle machine: `sysctl -n kern.memorystatus_vm_pressure_level` → 1.
  assert.equal(parsePressureLevel("1\n"), "normal");
  assert.equal(parsePressureLevel("2"), "warning");
  assert.equal(parsePressureLevel("4"), "critical");
  // 3 is not a level the kernel defines; inventing a meaning for it would be
  // exactly the fabrication this module forbids.
  assert.equal(parsePressureLevel("3"), null);
  assert.equal(parsePressureLevel(""), null);
  assert.equal(parsePressureLevel(undefined), null);
});

/* ── Battery ──────────────────────────────────────────────────────────────── */

/** Captured: `pmset -g batt`, plugged in and charged. */
const BATT_AC = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=22020195)\t100%; charged; 0:00 remaining present: true
`;

/**
 * Hand-written in pmset's documented shape to exercise the discharging branch;
 * the development machine could not be unplugged to capture it.
 */
const BATT_DISCHARGING = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=22020195)\t63%; discharging; 3:47 remaining present: true
`;

test("battery reads the power source, charge and state", () => {
  const battery = parseBattery(BATT_AC);
  assert.equal(battery.source, "AC Power");
  assert.equal(battery.onBattery, false);
  assert.equal(battery.percent, 100);
  assert.equal(battery.state, "charged");
  assert.equal(battery.present, true);
});

test("a 0:00 estimate is unknown, not empty", () => {
  // macOS prints 0:00 while it recalculates. Rendering that as "0 minutes
  // remaining" on a fully charged machine is worse than saying nothing.
  assert.equal(parseBattery(BATT_AC).minutesRemaining, null);
});

test("time remaining is minutes when macOS actually has an estimate", () => {
  const battery = parseBattery(BATT_DISCHARGING);
  assert.equal(battery.onBattery, true);
  assert.equal(battery.percent, 63);
  assert.equal(battery.state, "discharging");
  assert.equal(battery.minutesRemaining, 3 * 60 + 47);
});

/* ── Thermal ──────────────────────────────────────────────────────────────── */

/** Captured: `pmset -g therm` on a cool machine. */
const THERM_UNRECORDED = `Note: No thermal warning level has been recorded
Note: No performance warning level has been recorded
Note: No CPU power status has been recorded
`;

/** Hand-written in pmset's documented shape; the machine never throttled. */
const THERM_THROTTLED = `CPU_Scheduler_Limit \t= 100
CPU_Available_CPUs \t= 12
CPU_Speed_Limit \t= 74
`;

test("an unrecorded thermal level is not a reassuring 100", () => {
  const thermal = parseThermal(THERM_UNRECORDED);
  assert.equal(thermal.recorded, false);
  assert.equal(thermal.cpuSpeedLimitPercent, null);
  assert.match(thermal.note, /has not recorded/);
});

test("a recorded speed limit is read as a percentage", () => {
  const thermal = parseThermal(THERM_THROTTLED);
  assert.equal(thermal.recorded, true);
  assert.equal(thermal.cpuSpeedLimitPercent, 74);
  assert.equal(thermal.schedulerLimitPercent, 100);
  assert.equal(thermal.availableCpus, 12);
  assert.equal(thermal.note, null);
});

/* ── Disk ─────────────────────────────────────────────────────────────────── */

/** Captured: `df -k /`. */
const DF = `Filesystem     1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on
/dev/disk3s1s1   482766932  24728192  39916532    39%  449816 399165320    0%   /
`;

test("df blocks are 1024 bytes, and the mount survives the split", () => {
  const disk = parseDiskFree(DF);
  assert.equal(disk.mount, "/");
  assert.equal(disk.totalBytes, 482766932 * 1024);
  assert.equal(disk.freeBytes, 39916532 * 1024);
  assert.equal(disk.usedBytes, 24728192 * 1024);
});

test("a header-only df yields null", () => {
  assert.equal(parseDiskFree("Filesystem 1024-blocks Used Available Capacity Mounted on\n"), null);
  assert.equal(parseDiskFree(""), null);
});

/* ── Processes ────────────────────────────────────────────────────────────── */

/** Captured: `ps -Ao pid=,rss=,pcpu=,comm= -r | head`. */
const PS_OUTPUT = `10545  51232  40.0 /Applications/TeminaliCut.app/Contents/Frameworks/TeminaliCut Helper (GPU).app/Contents/MacOS/TeminaliCut Helper (GPU)
  406  94768  25.7 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer
10578 422768  17.0 /Applications/TeminaliCut.app/Contents/Frameworks/TeminaliCut Helper (Renderer).app/Contents/MacOS/TeminaliCut Helper (Renderer)
16052 308000   8.7 /Applications/Antigravity IDE.app/Contents/Frameworks/Antigravity IDE Helper (Renderer).app/Contents/MacOS/Antigravity IDE Helper (Renderer)
17814 158336   3.4 /Applications/WhatsApp.app/Contents/MacOS/WhatsApp
 1150  54688   0.0 /opt/homebrew/opt/ollama/bin/ollama
`;

test("ps rss is kilobytes and the command keeps its spaces", () => {
  const processes = parseProcessList(PS_OUTPUT, 24 * GB);
  assert.equal(processes.length, 6);
  assert.equal(processes[0].pid, 10545);
  assert.equal(processes[0].rssBytes, 51232 * 1024);
  assert.equal(processes[0].cpuPercent, 40);
  // The path has three spaces in it; a naive split on whitespace loses the tail.
  assert.match(processes[0].command, /Helper \(GPU\)$/);
});

test("memory percent is null when there is no total to divide by", () => {
  const [first] = parseProcessList(PS_OUTPUT);
  assert.equal(first.memoryPercent, null);
});

test("a bundle path collapses to the name a human would recognise", () => {
  assert.equal(
    displayNameForCommand("/Applications/TeminaliCut.app/Contents/Frameworks/TeminaliCut Helper (GPU).app/Contents/MacOS/TeminaliCut Helper (GPU)"),
    "TeminaliCut",
  );
  assert.equal(displayNameForCommand("/Applications/WhatsApp.app/Contents/MacOS/WhatsApp"), "WhatsApp");
  assert.equal(
    displayNameForCommand("/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer"),
    "WindowServer",
  );
  assert.equal(displayNameForCommand("/opt/homebrew/opt/ollama/bin/ollama"), "ollama");
  assert.equal(displayNameForCommand(""), null);
});

test("helper processes are summed into the app that owns them", () => {
  const grouped = groupProcessesByApp(parseProcessList(PS_OUTPUT, 24 * GB));
  const cut = grouped.find((group) => group.name === "TeminaliCut");
  // Two helpers of one app is one 463MB answer, not two small ones.
  assert.equal(cut.processCount, 2);
  assert.equal(cut.rssBytes, (51232 + 422768) * 1024);
  assert.equal(cut.cpuPercent, 57);
  // The pid kept is the largest member, so "reveal in Activity Monitor" lands
  // on the process actually holding the memory.
  assert.equal(cut.pid, 10578);
});

/* ── CPU ──────────────────────────────────────────────────────────────────── */

const cpuSample = (at, cores) => ({ at, cores });

test("utilisation is a delta between two samples", () => {
  const before = cpuSample(1000, [{ user: 100, nice: 0, sys: 50, irq: 0, idle: 850 }]);
  const after = cpuSample(2000, [{ user: 200, nice: 0, sys: 100, irq: 0, idle: 1700 }]);
  // 150 busy ticks of 1000 elapsed.
  const utilisation = cpuUtilisation(before, after);
  assert.equal(utilisation.percent, 15);
  assert.deepEqual(utilisation.perCore, [15]);
  assert.equal(utilisation.windowMs, 1000);
});

test("a single sample cannot produce a utilisation figure", () => {
  const sample = cpuSample(1000, [{ user: 100, nice: 0, sys: 50, irq: 0, idle: 850 }]);
  // A cumulative counter has no instantaneous value; null beats reporting the
  // since-boot average as if it described this second.
  assert.equal(cpuUtilisation(null, sample), null);
  assert.equal(cpuUtilisation(sample, null), null);
  assert.equal(cpuUtilisation(sample, sample), null);
});

test("core-count changes between samples invalidate the delta", () => {
  const before = cpuSample(1000, [{ user: 1, nice: 0, sys: 1, irq: 0, idle: 8 }]);
  const after = cpuSample(2000, [
    { user: 2, nice: 0, sys: 2, irq: 0, idle: 16 },
    { user: 2, nice: 0, sys: 2, irq: 0, idle: 16 },
  ]);
  assert.equal(cpuUtilisation(before, after), null);
});

/* ── Ollama residency ─────────────────────────────────────────────────────── */

/** Captured: `curl http://127.0.0.1:11434/api/ps` with qwen3-vl:2b resident. */
const OLLAMA_PS = {
  models: [
    {
      name: "qwen3-vl:2b",
      model: "qwen3-vl:2b",
      size: 2743429920,
      digest: "0635d9d857d497aeadba3d7d27485746c50554446f9f6ec01ef39788221adbe8",
      details: {
        parent_model: "",
        format: "gguf",
        family: "qwen3vl",
        families: ["qwen3vl"],
        parameter_size: "2.1B",
        quantization_level: "Q4_K_M",
      },
      expires_at: "2026-09-01T23:46:53.584919+03:00",
      size_vram: 2743429920,
      context_length: 4096,
    },
  ],
};

const EXPIRES_MS = Date.parse("2026-09-01T23:46:53.584919+03:00");

test("a resident model reports what is wired, not what is installed", () => {
  const now = EXPIRES_MS - 120_000;
  const [model] = normaliseResidentModels(OLLAMA_PS, now);
  assert.equal(model.name, "qwen3-vl:2b");
  assert.equal(model.vramBytes, 2743429920);
  assert.equal(model.contextLength, 4096);
  assert.equal(model.parameterSize, "2.1B");
  assert.equal(model.quantization, "Q4_K_M");
  assert.equal(model.expiresInSeconds, 120);
});

test("an empty /api/ps means nothing is resident, not that Ollama is down", () => {
  assert.deepEqual(normaliseResidentModels({ models: [] }), []);
  assert.deepEqual(normaliseResidentModels({}), []);
  assert.deepEqual(normaliseResidentModels(null), []);
});

test("idle time is a lower bound until the expiry is seen to move", () => {
  const start = EXPIRES_MS - 300_000;
  const models = normaliseResidentModels(OLLAMA_PS, start);

  const first = trackResidency(new Map(), models, start);
  // First sighting: we cannot know when it loaded, so the flag says so.
  assert.equal(first.models[0].idleSeconds, 0);
  assert.equal(first.models[0].idleIsLowerBound, true);

  const later = start + 60_000;
  const second = trackResidency(first.registry, normaliseResidentModels(OLLAMA_PS, later), later);
  // Expiry unchanged over a minute means the model was not touched for a minute.
  assert.equal(second.models[0].idleSeconds, 60);
  assert.equal(second.models[0].idleIsLowerBound, true);
  assert.equal(second.models[0].observedForSeconds, 60);
});

test("an advancing expiry resets the idle clock and drops the lower-bound flag", () => {
  const start = EXPIRES_MS - 300_000;
  const first = trackResidency(new Map(), normaliseResidentModels(OLLAMA_PS, start), start);

  // A request arrived: Ollama pushed expires_at forward by five minutes.
  const used = { models: [{ ...OLLAMA_PS.models[0], expires_at: "2026-09-01T23:51:53.584919+03:00" }] };
  const at = start + 60_000;
  const second = trackResidency(first.registry, normaliseResidentModels(used, at), at);
  assert.equal(second.models[0].idleSeconds, 0);
  assert.equal(second.models[0].idleIsLowerBound, false);

  const at2 = at + 90_000;
  const third = trackResidency(second.registry, normaliseResidentModels(used, at2), at2);
  // Now the idle figure is exact — we watched the last use happen.
  assert.equal(third.models[0].idleSeconds, 90);
  assert.equal(third.models[0].idleIsLowerBound, false);
});

test("a model that leaves is dropped from the registry", () => {
  const start = EXPIRES_MS - 300_000;
  const first = trackResidency(new Map(), normaliseResidentModels(OLLAMA_PS, start), start);
  const second = trackResidency(first.registry, [], start + 1000);
  assert.equal(second.registry.size, 0);
  assert.deepEqual(second.models, []);
});

/* ── Advice ───────────────────────────────────────────────────────────────── */

/** A machine with room to spare and nothing loaded. */
function calmSnapshot(overrides = {}) {
  return {
    memory: { totalBytes: 24 * GB, availableBytes: 12 * GB, usedBytes: 12 * GB, usedPercent: 50, pressure: "normal" },
    swap: { totalBytes: 5 * GB, usedBytes: 0, usedPercent: 0 },
    ollama: { reachable: true, residentModels: [] },
    processes: { byMemory: [], byCpu: [] },
    power: { onBattery: false, source: "AC Power", percent: 100 },
    thermal: { recorded: false, cpuSpeedLimitPercent: null },
    cpu: { cores: 12, percent: 10 },
    load: [1.2, 1.1, 1.0],
    ...overrides,
  };
}

const resident = (overrides = {}) => ({
  name: "qwen2.5-coder:14b",
  vramBytes: 9 * GB,
  sizeBytes: 9 * GB,
  idleSeconds: 720,
  idleIsLowerBound: false,
  observedForSeconds: 900,
  expiresInSeconds: 180,
  ...overrides,
});

test("a quiet machine says so instead of manufacturing a warning", () => {
  const advice = buildAdvice(calmSnapshot());
  assert.equal(advice.length, 1);
  assert.equal(advice[0].id, "clear");
  assert.match(advice[0].detail, /No model is resident/);
});

test("an idle resident model names the memory unloading would free", () => {
  const advice = buildAdvice(
    calmSnapshot({ ollama: { reachable: true, residentModels: [resident()] } }),
  );
  const idle = advice.find((entry) => entry.id.startsWith("idle-model:"));
  assert.equal(idle.action.kind, "unload");
  assert.equal(idle.action.model, "qwen2.5-coder:14b");
  assert.match(idle.detail, /Unloading frees 9\.0 GB/);
  assert.ok(idle.evidence.some((line) => /idle 12 min/.test(line)));
});

test("a lower-bound idle figure says so in its own evidence", () => {
  const advice = buildAdvice(
    calmSnapshot({
      ollama: { reachable: true, residentModels: [resident({ idleIsLowerBound: true, observedForSeconds: 720 })] },
    }),
  );
  const idle = advice.find((entry) => entry.id.startsWith("idle-model:"));
  assert.ok(idle.evidence.some((line) => /or more \(watched for 12 min\)/.test(line)));
});

test("a model in active use is not proposed for unloading", () => {
  const advice = buildAdvice(
    calmSnapshot({ ollama: { reachable: true, residentModels: [resident({ idleSeconds: 5 })] } }),
  );
  assert.equal(advice.some((entry) => entry.id.startsWith("idle-model:")), false);
});

test("swap under a resident model is the loudest thing the panel can say", () => {
  const advice = buildAdvice(
    calmSnapshot({
      swap: { totalBytes: 5 * GB, usedBytes: 3.6 * GB, usedPercent: 72 },
      ollama: { reachable: true, residentModels: [resident({ idleSeconds: 0 })] },
    }),
  );
  const swap = advice.find((entry) => entry.id === "swap-under-model");
  assert.equal(swap.severity, "critical");
  assert.ok(swap.evidence.some((line) => /swap used 3\.6 GB of 5\.0 GB/.test(line)));
  assert.ok(swap.evidence.some((line) => /1 model resident, 9\.0 GB wired/.test(line)));
});

test("two resident models are flagged with their combined footprint", () => {
  const advice = buildAdvice(
    calmSnapshot({
      ollama: {
        reachable: true,
        residentModels: [resident({ idleSeconds: 0 }), resident({ name: "llama3.2:3b", vramBytes: 3 * GB, idleSeconds: 0 })],
      },
    }),
  );
  const multiple = advice.find((entry) => entry.id === "multiple-resident");
  assert.match(multiple.title, /2 models are resident/);
  assert.ok(multiple.evidence.some((line) => /12 GB wired in total/.test(line)));
});

test("kernel pressure is attributed to the kernel, not to this app", () => {
  const advice = buildAdvice(
    calmSnapshot({
      memory: { totalBytes: 24 * GB, availableBytes: 2 * GB, usedBytes: 22 * GB, usedPercent: 92, pressure: "critical" },
    }),
  );
  const pressure = advice.find((entry) => entry.id === "memory-pressure");
  assert.equal(pressure.severity, "critical");
  assert.ok(pressure.evidence.some((line) => /kern\.memorystatus_vm_pressure_level/.test(line)));
});

test("the largest competing process is named only when memory is contested", () => {
  const processes = {
    byMemory: [{ name: "Microsoft Edge", rssBytes: 4 * GB, memoryPercent: 16.6, processCount: 18 }],
    byCpu: [],
  };
  // Plenty free: naming Edge here would just be listing the operator's own apps.
  assert.equal(buildAdvice(calmSnapshot({ processes })).some((e) => e.id.startsWith("competing:")), false);

  const tight = buildAdvice(
    calmSnapshot({
      processes,
      memory: { totalBytes: 24 * GB, availableBytes: 2 * GB, usedBytes: 22 * GB, usedPercent: 92, pressure: "warning" },
    }),
  );
  const competing = tight.find((entry) => entry.id === "competing:Microsoft Edge");
  assert.ok(competing.evidence.some((line) => /4\.0 GB resident across 18 processes/.test(line)));
});

test("ollama's own process is never proposed as the thing to quit", () => {
  const advice = buildAdvice(
    calmSnapshot({
      processes: { byMemory: [{ name: "ollama", rssBytes: 9 * GB, memoryPercent: 37, processCount: 2 }], byCpu: [] },
      memory: { totalBytes: 24 * GB, availableBytes: 2 * GB, usedBytes: 22 * GB, usedPercent: 92, pressure: "warning" },
    }),
  );
  // Quitting the server that holds the model is not advice, it is a bug report.
  assert.equal(advice.some((entry) => entry.id.startsWith("competing:")), false);
});

test("a recorded speed limit is reported, an unrecorded one is not", () => {
  assert.equal(buildAdvice(calmSnapshot()).some((e) => e.id === "thermal-throttle"), false);
  const throttled = buildAdvice(
    calmSnapshot({ thermal: { recorded: true, cpuSpeedLimitPercent: 74 } }),
  );
  assert.ok(throttled.some((entry) => entry.id === "thermal-throttle"));
});

test("battery advice only appears when a model is actually resident", () => {
  const idleOnBattery = calmSnapshot({ power: { onBattery: true, source: "Battery Power", percent: 63, minutesRemaining: 227 } });
  assert.equal(buildAdvice(idleOnBattery).some((e) => e.id === "on-battery"), false);

  const loaded = buildAdvice({ ...idleOnBattery, ollama: { reachable: true, residentModels: [resident({ idleSeconds: 0 })] } });
  const battery = loaded.find((entry) => entry.id === "on-battery");
  assert.ok(battery.evidence.some((line) => /battery 63%/.test(line)));
});

test("every observation carries the evidence it was drawn from", () => {
  const busy = calmSnapshot({
    memory: { totalBytes: 24 * GB, availableBytes: 1.5 * GB, usedBytes: 22.5 * GB, usedPercent: 94, pressure: "critical" },
    swap: { totalBytes: 5 * GB, usedBytes: 4 * GB, usedPercent: 80 },
    ollama: { reachable: true, residentModels: [resident(), resident({ name: "llama3.2:3b", vramBytes: 3 * GB })] },
    processes: { byMemory: [{ name: "Google Chrome", rssBytes: 5 * GB, memoryPercent: 20, processCount: 9 }], byCpu: [] },
    thermal: { recorded: true, cpuSpeedLimitPercent: 60 },
    power: { onBattery: true, source: "Battery Power", percent: 40, minutesRemaining: 55 },
    load: [22.4, 18.0, 14.2],
  });
  const advice = buildAdvice(busy);
  assert.ok(advice.length >= 6);
  for (const entry of advice) {
    assert.ok(entry.id, "every observation is addressable");
    assert.ok(["info", "warning", "critical"].includes(entry.severity));
    assert.ok(Array.isArray(entry.evidence) && entry.evidence.length > 0, `${entry.id} states its evidence`);
    for (const line of entry.evidence) assert.equal(typeof line, "string");
  }
  assert.ok(advice.some((entry) => entry.id === "run-queue"));
});

test("advice never draws a memory conclusion from a memory reading that failed", () => {
  // vm_stat failed: availableBytes is null, and `null < 3GB` is true in JS.
  // Left unguarded that emits a headroom warning built on nothing.
  const blind = calmSnapshot({
    memory: { totalBytes: 24 * GB, availableBytes: null, usedBytes: null, usedPercent: null, pressure: null },
  });
  const advice = buildAdvice(blind);
  assert.equal(advice.some((entry) => entry.id === "tight-headroom"), false);
  assert.equal(advice.some((entry) => entry.id === "clear"), false);
  const unmeasured = advice.find((entry) => entry.id === "memory-unmeasured");
  assert.equal(unmeasured.severity, "info");
  assert.ok(unmeasured.evidence.length > 0);
});

test("a resident model is still reported when memory could not be read", () => {
  // Residency comes from Ollama, not from vm_stat; losing one must not lose both.
  const advice = buildAdvice(
    calmSnapshot({
      memory: { totalBytes: 24 * GB, availableBytes: null, usedBytes: null, usedPercent: null, pressure: null },
      ollama: { reachable: true, residentModels: [resident()] },
    }),
  );
  assert.ok(advice.some((entry) => entry.id === "idle-model:qwen2.5-coder:14b"));
});
