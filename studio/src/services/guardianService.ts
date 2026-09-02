import { GatewayClient } from "./gatewayClient";

/**
 * Client for the guardian telemetry routes.
 *
 * Every numeric field is `| null` on purpose: the server reports a metric it
 * could not measure as null and names it in `unavailable`, and the types have
 * to carry that through so a component cannot accidentally render a missing
 * reading as zero.
 */

export interface ResidentModel {
  name: string;
  digest: string | null;
  sizeBytes: number | null;
  /** What the model actually holds in unified memory right now. */
  vramBytes: number | null;
  contextLength: number | null;
  parameterSize: string | null;
  quantization: string | null;
  family: string | null;
  expiresAt: string | null;
  expiresInSeconds: number | null;
  idleSeconds: number;
  /** True while we have not yet watched the model's expiry move. */
  idleIsLowerBound: boolean;
  observedForSeconds: number;
}

export interface GuardianAdvice {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  /** The measurements the observation was drawn from, in words. */
  evidence: string[];
  action?: { kind: "unload"; model: string };
}

export interface ProcessGroup {
  name: string;
  pid: number;
  rssBytes: number;
  cpuPercent: number;
  processCount: number;
  memoryPercent: number | null;
}

export interface GuardianSnapshot {
  capturedAt: string;
  platform: string;
  host: { hostname: string; release: string; arch: string; uptimeSeconds: number };
  cpu: { cores: number; percent: number | null; perCore: (number | null)[]; windowMs: number | null };
  load: number[];
  memory: {
    totalBytes: number;
    freeBytes: number | null;
    activeBytes?: number;
    inactiveBytes?: number;
    wiredBytes?: number;
    purgeableBytes?: number;
    compressedBytes?: number;
    availableBytes: number | null;
    usedBytes: number | null;
    usedPercent: number | null;
    pressure: "normal" | "warning" | "critical" | null;
  };
  swap: { totalBytes: number; usedBytes: number; freeBytes: number | null; encrypted: boolean; usedPercent: number } | null;
  thermal: {
    recorded: boolean;
    cpuSpeedLimitPercent: number | null;
    schedulerLimitPercent: number | null;
    availableCpus: number | null;
    note: string | null;
  } | null;
  power: {
    source: string | null;
    onBattery: boolean | null;
    percent: number | null;
    state: string | null;
    minutesRemaining: number | null;
    present: boolean | null;
    cycleCount?: number | null;
    health?: string | null;
    maximumCapacityPercent?: number | null;
  };
  disk: { mount: string; totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number | null } | null;
  ollama: {
    reachable: boolean;
    url: string;
    residentModels: ResidentModel[];
    totalVramBytes: number;
    error: string | null;
  };
  processes: { total: number | null; byMemory: ProcessGroup[]; byCpu: ProcessGroup[] };
  unavailable: { metric: string; reason: string }[];
  advice: GuardianAdvice[];
}

export interface UnloadResult {
  model: string;
  unloaded: boolean;
  freedBytes: number | null;
  stillResident: boolean | null;
  detail: string | null;
}

export class GuardianService {
  static async snapshot(signal?: AbortSignal): Promise<GuardianSnapshot> {
    const response = await GatewayClient.request("/api/guardian/snapshot", { method: "GET", signal });
    await GatewayClient.expectOk(response);
    return (await response.json()) as GuardianSnapshot;
  }

  /** Evict a resident model. Resolves with what was actually freed, re-checked. */
  /**
   * The machine-pressure view: what is open, what could be closed, and what the
   * disk looks like.
   *
   * This backend was built and tested but nothing in the interface had ever
   * called it. Guardian reports; it never closes anything on its own — the
   * `enforce` call below is the only thing that acts, and only when the
   * operator asks.
   */
  static async governor(signal?: AbortSignal): Promise<GovernorReport> {
    const response = await GatewayClient.request("/api/guardian/governor", { method: "GET", signal });
    await GatewayClient.expectOk(response);
    return (await response.json()) as GovernorReport;
  }

  /**
   * Closes the apps the plan named.
   *
   * `confirm` is required by the gateway and is deliberately not defaulted
   * here: closing someone's applications is not something a client should be
   * able to do by forgetting a flag. The gateway also re-derives the plan
   * rather than trusting this list, so an app that has since gained unsaved
   * work is spared even though it was named.
   */
  static async enforce(apps: string[]): Promise<{ results: { name: string; ok: boolean; detail?: string }[] }> {
    const response = await GatewayClient.request("/api/guardian/governor/enforce", {
      method: "POST",
      body: JSON.stringify({ apps, confirm: true }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as { results: { name: string; ok: boolean; detail?: string }[] };
  }

  static async unload(model: string): Promise<UnloadResult> {
    const response = await GatewayClient.request("/api/guardian/unload", {
      method: "POST",
      body: JSON.stringify({ model }),
    });
    await GatewayClient.expectOk(response);
    return (await response.json()) as UnloadResult;
  }
}

/* ── Formatting ───────────────────────────────────────────────────────────── */

/**
 * These live beside the types rather than in the component because the tray
 * menu formats the same figures and the two must never disagree about whether
 * 2.56 GB rounds to 2.6 or 3.
 */

/** A byte count, or an em dash — never a zero standing in for "not measured". */
export function formatBytes(bytes: number | null | undefined): string {
  if (!Number.isFinite(bytes as number)) return "—";
  const value = bytes as number;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  const gigabytes = value / 1024 ** 3;
  return `${gigabytes.toFixed(gigabytes < 10 ? 1 : 0)} GB`;
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  return Number.isFinite(value as number) ? `${(value as number).toFixed(digits)}%` : "—";
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds as number)) return "—";
  const value = Math.max(0, Math.round(seconds as number));
  if (value < 60) return `${value}s`;
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return hours < 24 ? `${hours.toFixed(1)}h` : `${Math.round(hours / 24)}d`;
}

/** One application Guardian can see, and whether it is safe to close. */
export interface GovernorApp {
  name: string;
  pid: number | null;
  rssBytes: number | null;
  cpuPercent: number | null;
  hasUnsavedWork: boolean;
}

/** Shapes mirrored from server/guardian-governor.js — verified against a live call. */
export interface GovernorReport {
  settings: { enabled?: boolean; [key: string]: unknown };
  /** False on a platform where Guardian cannot enumerate applications. */
  supported: boolean;
  detail: string | null;
  frontmost: string | null;
  apps: GovernorApp[];
  plan: {
    openCount: number;
    limit: number | null;
    overBy: number;
    /** Would be closed, in order. */
    selected: { name: string; pid: number | null; rssBytes: number | null; idleMinutes: number | null; reason: string }[];
    /** Considered and spared, each with the reason it was left alone. */
    spared: { name: string; reason: string }[];
    /** Over the cap, but nothing may safely be closed. */
    blocked: boolean;
    reclaimableBytes: number;
  };
  storage: {
    totalBytes: number | null;
    freeBytes: number | null;
    purgeableBytes: number | null;
    effectiveFreeBytes: number | null;
    headroomRatio: number | null;
    level: "ok" | "warn" | "critical" | string;
    detail: string | null;
  };
}
