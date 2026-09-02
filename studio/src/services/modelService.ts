import { GatewayClient } from "./gatewayClient";

/**
 * Client for the model library, hosted providers, and GitHub.
 *
 * Every judgement about whether a model will run — the fit level, the memory
 * requirement, the speed estimate — is computed on the server against the real
 * machine. Nothing here re-derives any of it, because two implementations of
 * the same arithmetic would eventually disagree and the badge would stop
 * meaning anything.
 */

export type FitLevel = "recommended" | "supported" | "tight" | "unsupported";
export type SpeedBand = "instant" | "fast" | "steady" | "slow" | "impractical" | "unknown";

export interface DeviceInfo {
  platform: string;
  arch: string;
  brand: string | null;
  chip: string | null;
  accelerator: string;
  cpuCores: number;
  performanceCores: number | null;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  usableMemoryBytes: number;
  bandwidthGBs: number | null;
}

export interface ModelFit {
  level: FitLevel;
  reason: string;
  requiredBytes: number;
  usableBytes: number;
  headroomBytes: number;
  utilisation: number;
  tokensPerSecond: number | null;
  speed: SpeedBand;
}

export interface LibraryModel {
  tag: string;
  name: string;
  family: string;
  params: number;
  bytes: number;
  context: number;
  capabilities: string[];
  useCase: string;
  tier: "tiny" | "small" | "medium" | "large" | "xlarge";
  flagship?: boolean;
  custom?: boolean;
  installed: boolean;
  installedTag: string | null;
  fit: ModelFit;
}

export interface RoutingLane {
  tag: string;
  name: string;
  bytes: number;
  tier: string;
  capabilities: string[];
  fit: ModelFit;
}

export interface RoutingPlan {
  light: RoutingLane | null;
  heavy: RoutingLane | null;
  vision: RoutingLane | null;
  embedding: RoutingLane | null;
  candidateCount: number;
  degraded: boolean;
}

export interface LibraryResponse {
  connected: boolean;
  device: DeviceInfo;
  models: LibraryModel[];
  routing: RoutingPlan;
}

export interface ProviderLane {
  model: string;
  label: string;
  note: string;
}

export interface ProviderInfo {
  id: "anthropic" | "openai" | "google";
  label: string;
  envVar: string;
  docsUrl: string;
  configured: boolean;
  source: "stored" | "environment" | null;
  hint: string | null;
  enabled: boolean;
  lanes: { light: ProviderLane; heavy: ProviderLane };
  flagship: ProviderLane;
  updatedAt: string | null;
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  routing: {
    provider: string | null;
    providerLabel?: string;
    light: (ProviderLane & { provider: string }) | null;
    heavy: (ProviderLane & { provider: string }) | null;
    flagshipExcluded?: ProviderLane;
    degraded: boolean;
  };
}

export interface GitHubStatus {
  connected: boolean;
  method: "cli" | "token" | null;
  cliVersion: string | null;
  login?: string;
  name?: string | null;
  avatarUrl?: string | null;
  scopes?: string[];
  canClone?: boolean;
  detail: string | null;
}

export interface GitHubRepo {
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  language: string | null;
  pushedAt: string | null;
  url: string;
  sizeKb: number | null;
  stars: number;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await GatewayClient.request(path, { method: "GET", signal });
  await GatewayClient.expectOk(response);
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await GatewayClient.request(path, { method: "POST", signal, body: JSON.stringify(body) });
  await GatewayClient.expectOk(response);
  return (await response.json()) as T;
}

export const ModelService = {
  device: (signal?: AbortSignal) => getJson<DeviceInfo>("/api/system/device", signal),
  library: (signal?: AbortSignal) => getJson<LibraryResponse>("/api/models/library", signal),

  /** Which model a prompt would actually run on, without running it. */
  resolve: (prompt: string, mode: "flash" | "auto" | "max", signal?: AbortSignal) =>
    postJson<{
      mode: string;
      local: { lane: string; reason: string; complexity: number; model: RoutingLane | null; plan: RoutingPlan };
      hosted: { degraded: boolean; model?: ProviderLane & { provider: string }; providerLabel?: string };
    }>("/api/models/resolve", { prompt, mode }, signal),

  pull: (model: string, signal?: AbortSignal) => postJson<unknown>("/api/models/pull", { model }, signal),
};

export const ProviderService = {
  list: (signal?: AbortSignal) => getJson<ProvidersResponse>("/api/providers", signal),
  setKey: (provider: string, key: string | null, signal?: AbortSignal) =>
    postJson<ProvidersResponse>("/api/providers/key", { provider, key }, signal),
  setLanes: (
    provider: string,
    lanes: { lightModel?: string; heavyModel?: string; enabled?: boolean },
    signal?: AbortSignal,
  ) => postJson<ProvidersResponse>("/api/providers/lanes", { provider, ...lanes }, signal),
};

export const GitHubService = {
  status: (signal?: AbortSignal) => getJson<GitHubStatus>("/api/github/status", signal),
  repos: (signal?: AbortSignal) => getJson<{ source: string | null; repos: GitHubRepo[] }>("/api/github/repos", signal),
  setToken: (token: string | null, signal?: AbortSignal) =>
    postJson<GitHubStatus>("/api/github/token", { token }, signal),
  clone: (repo: string, directory?: string, signal?: AbortSignal) =>
    postJson<{ path: string; name: string; method: string }>("/api/github/clone", { repo, directory }, signal),
};

/* ── Formatting helpers, shared by every view that shows these numbers ────── */

export function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function formatParams(params: number): string {
  if (!params) return "—";
  // Keep one decimal until three digits, so 14.8B does not round to 15B.
  return params >= 1e9 ? `${(params / 1e9).toFixed(params >= 1e11 ? 0 : 1)}B` : `${(params / 1e6).toFixed(0)}M`;
}

export const FIT_COPY: Record<FitLevel, { label: string; tone: "success" | "accent" | "warning" | "danger" }> = {
  recommended: { label: "Runs well", tone: "success" },
  supported: { label: "Supported", tone: "accent" },
  tight: { label: "Tight fit", tone: "warning" },
  unsupported: { label: "Won't fit", tone: "danger" },
};

export const SPEED_COPY: Record<SpeedBand, string> = {
  instant: "instant",
  fast: "fast",
  steady: "steady",
  slow: "slow",
  impractical: "too slow to use",
  unknown: "unknown",
};
