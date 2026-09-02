/**
 * Device capability detection.
 *
 * Everything the model library says about "will this run on my machine" is
 * derived from here, so the numbers have to be real rather than guessed. On
 * macOS that means asking sysctl rather than trusting Node's os module alone:
 * `os.totalmem()` is right, but the interesting figure on Apple Silicon is how
 * much of that unified memory the GPU is actually allowed to wire down, which
 * is a separate limit entirely.
 */

import os from "node:os";
import { execFileSync } from "node:child_process";

/**
 * macOS reserves part of unified memory for the system and caps what the GPU
 * may wire. The default ceiling is about 75% of physical RAM (a little higher
 * on machines with 36GB+). Anything above that ceiling spills to swap, which
 * turns a "large model" into an unusable one, so it is the number the library
 * budgets against — not total RAM.
 */
const APPLE_GPU_WIRED_FRACTION = 0.75;
const APPLE_GPU_WIRED_FRACTION_LARGE = 0.8;
const LARGE_MEMORY_THRESHOLD = 36 * 1024 ** 3;

function sysctl(key) {
  try {
    return execFileSync("sysctl", ["-n", key], { encoding: "utf8", timeout: 2000 }).trim();
  } catch {
    return null;
  }
}

/** Apple Silicon generation and tier, parsed from the CPU brand string. */
function parseAppleChip(brand) {
  if (!brand) return null;
  const match = /Apple (M\d+)(?:\s+(Pro|Max|Ultra))?/i.exec(brand);
  if (!match) return null;
  return {
    family: match[1].toUpperCase(),
    tier: match[2] ? match[2][0].toUpperCase() + match[2].slice(1).toLowerCase() : "Base",
  };
}

/**
 * Memory bandwidth, GB/s, by Apple Silicon model. Bandwidth is the dominant
 * term in local inference speed — a decode step reads the whole model from
 * memory — so it is a far better predictor than core count.
 */
const APPLE_BANDWIDTH = {
  "M1:Base": 68, "M1:Pro": 200, "M1:Max": 400, "M1:Ultra": 800,
  "M2:Base": 100, "M2:Pro": 200, "M2:Max": 400, "M2:Ultra": 800,
  "M3:Base": 100, "M3:Pro": 150, "M3:Max": 400, "M3:Ultra": 800,
  "M4:Base": 120, "M4:Pro": 273, "M4:Max": 546,
  "M5:Base": 150, "M5:Pro": 300, "M5:Max": 600,
};

/** Detect the host. Never throws — an unknown field is reported as null. */
export function detectDevice() {
  const platform = process.platform;
  const arch = process.arch;
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const cpus = os.cpus();

  let chip = null;
  let brand = null;
  let performanceCores = null;
  let efficiencyCores = null;
  let bandwidthGBs = null;
  let accelerator = "cpu";
  let usableMemoryBytes = Math.floor(totalMemoryBytes * 0.7);

  if (platform === "darwin") {
    brand = sysctl("machdep.cpu.brand_string");
    chip = parseAppleChip(brand);
    if (chip) {
      accelerator = "apple-unified";
      const perf = Number(sysctl("hw.perflevel0.logicalcpu"));
      const eff = Number(sysctl("hw.perflevel1.logicalcpu"));
      performanceCores = Number.isFinite(perf) && perf > 0 ? perf : null;
      efficiencyCores = Number.isFinite(eff) && eff > 0 ? eff : null;
      bandwidthGBs = APPLE_BANDWIDTH[`${chip.family}:${chip.tier}`] ?? null;

      const fraction =
        totalMemoryBytes >= LARGE_MEMORY_THRESHOLD
          ? APPLE_GPU_WIRED_FRACTION_LARGE
          : APPLE_GPU_WIRED_FRACTION;
      // An explicit iogpu.wired_limit_mb overrides the default ceiling.
      const wiredLimitMb = Number(sysctl("iogpu.wired_limit_mb"));
      usableMemoryBytes =
        Number.isFinite(wiredLimitMb) && wiredLimitMb > 0
          ? wiredLimitMb * 1024 ** 2
          : Math.floor(totalMemoryBytes * fraction);
    } else {
      // Intel Mac: no unified memory, so inference is CPU-bound unless a
      // discrete GPU is present, which Ollama on macOS does not use for LLMs.
      accelerator = "cpu";
      usableMemoryBytes = Math.floor(totalMemoryBytes * 0.7);
    }
  } else if (platform === "linux" || platform === "win32") {
    // Without a reliable cross-platform VRAM probe, budget against system RAM
    // and say so, rather than inventing a GPU figure.
    usableMemoryBytes = Math.floor(totalMemoryBytes * 0.75);
    accelerator = "unknown";
  }

  return {
    platform,
    arch,
    brand: brand ?? (cpus[0]?.model ?? null),
    chip: chip ? `Apple ${chip.family} ${chip.tier === "Base" ? "" : chip.tier}`.trim() : null,
    chipFamily: chip?.family ?? null,
    chipTier: chip?.tier ?? null,
    accelerator,
    cpuCores: cpus.length,
    performanceCores,
    efficiencyCores,
    totalMemoryBytes,
    freeMemoryBytes,
    /** What a model may actually occupy before the machine starts swapping. */
    usableMemoryBytes,
    bandwidthGBs,
    detectedAt: new Date().toISOString(),
  };
}
