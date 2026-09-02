
/**
 * The gateway the main process started, when there is one.
 *
 * A packaged build runs the gateway inside Electron and publishes its address
 * and session token over the preload bridge. That is the only way the packaged
 * renderer can be authenticated: it is a file:// page, Chromium sends its
 * requests with no Origin header, and /api/session refuses to mint a token
 * without an allowed browser origin. In development the bridge is absent and
 * the ordinary POST bootstrap runs against the Vite proxy.
 */
interface InjectedGateway {
  url: string;
  token: string;
}

function injectedGateway(): InjectedGateway | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as { teminali?: { gateway?: Partial<InjectedGateway> | null } }).teminali;
  const gateway = bridge?.gateway;
  if (!gateway?.url || !gateway?.token) return null;
  return { url: gateway.url, token: gateway.token };
}

export function resolveGatewayUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  // The port is only known at runtime: 4310 is preferred but a second instance,
  // or a development gateway already holding it, moves the app to another one.
  const injected = injectedGateway();
  if (injected) return `${injected.url}${cleanPath}`;
  const isFileProtocol = typeof window !== "undefined" && window.location.protocol === "file:";
  const base = isFileProtocol ? "http://127.0.0.1:4310" : "";
  return `${base}${cleanPath}`;
}
import type { ModelModeId, RuntimeHealthReport, RuntimeState, ServiceHealth } from "../types";

export interface FrontierModeStatus {
  defaultMode: "auto";
  maxQualified: boolean;
  modes: Record<ModelModeId, { label: string; description: string; available: boolean }>;
  models: {
    flash: { model: string; contextTokens: number };
    max: { model: string; contextTokens: number };
  };
}

export interface FrontierModelSelection {
  mode: ModelModeId;
  profile: "local" | "local-expert";
  reason: "flash_always_light" | "max_always_heavy" | "expert_pending_qualification" | "auto_complex_task" | "auto_light_task";
  expertQualified: boolean;
  complexity?: number;
  label: string;
  model: string;
  contextTokens: number;
}

interface GatewayErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

interface GatewayDependencyHealth {
  state: "healthy" | "degraded" | "offline";
  status?: number;
  latencyMs: number;
  errorCode?: string;
}

interface GatewayHealthPayload {
  state: "healthy" | "degraded";
  timestamp: string;
  gateway: {
    state: "healthy";
    bind: string;
  };
  dependencies: {
    ollama: GatewayDependencyHealth;
    teminaliCutMcp?: GatewayDependencyHealth;
  };
}

export class GatewayError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(message: string, code = "GATEWAY_ERROR", status = 500) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
  }
}

function toServiceHealth(name: string, dependency?: GatewayDependencyHealth): ServiceHealth {
  if (!dependency) {
    return {
      state: "offline",
      latencyMs: null,
      detail: `${name} is unreachable`,
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    state: dependency.state,
    latencyMs: typeof dependency.latencyMs === "number" ? dependency.latencyMs : null,
    detail: dependency.state === "healthy"
      ? `${name} reachable${dependency.status ? ` (HTTP ${dependency.status})` : ""}`
      : `${name} ${dependency.errorCode || dependency.state}`,
    checkedAt: new Date().toISOString(),
  };
}

export class GatewayClient {
  private static tokenPromise: Promise<string> | null = null;

  private static async getToken(): Promise<string> {
    // Handed over by the main process in a packaged build; nothing to fetch.
    const injected = injectedGateway();
    if (injected) return injected.token;
    if (!this.tokenPromise) {
      this.tokenPromise = fetch(resolveGatewayUrl("/api/session"), {
        method: "POST",
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new GatewayError("The local gateway session could not be created.", "SESSION_UNAVAILABLE", response.status);
          }
          const data = (await response.json()) as { token?: string };
          if (!data.token) {
            throw new GatewayError("The local gateway returned an invalid session.", "INVALID_SESSION", response.status);
          }
          return data.token;
        })
        .catch((error) => {
          this.tokenPromise = null;
          throw error;
        });
    }
    return this.tokenPromise;
  }

  public static async request(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    const headers = new Headers(init.headers);
    // FormData and Blob bodies carry their own content type — a multipart
    // upload needs the boundary the browser generates, and overwriting it with
    // application/json makes the body unparseable at the other end.
    const bodyIsSelfDescribing =
      typeof FormData !== "undefined" && init.body instanceof FormData
        ? true
        : typeof Blob !== "undefined" && init.body instanceof Blob;
    if (!headers.has("Content-Type") && init.body && !bodyIsSelfDescribing) {
      headers.set("Content-Type", "application/json");
    }
    if (authenticated) headers.set("Authorization", `Bearer ${await this.getToken()}`);

    let response: Response;
    try {
      response = await fetch(resolveGatewayUrl(path), { ...init, headers });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new GatewayError("The local Frontier gateway is offline.", "GATEWAY_OFFLINE", 503);
    }

    if (response.status === 401 && authenticated) {
      this.tokenPromise = null;
      headers.set("Authorization", `Bearer ${await this.getToken()}`);
      response = await fetch(resolveGatewayUrl(path), { ...init, headers });
    }
    return response;
  }

  public static async expectOk(response: Response): Promise<Response> {
    if (response.ok) return response;
    let body: GatewayErrorBody = {};
    try {
      body = (await response.clone().json()) as GatewayErrorBody;
    } catch {
      body = {};
    }
    throw new GatewayError(
      body.error?.message || `Gateway request failed with HTTP ${response.status}.`,
      body.error?.code || "HTTP_ERROR",
      response.status,
    );
  }

  public static async getHealth(): Promise<RuntimeHealthReport> {
    const response = await this.request("/api/health", { method: "GET" }, false);
    await this.expectOk(response);
    const payload = (await response.json()) as GatewayHealthPayload;

    const overallState: RuntimeState =
      payload.gateway.state === "healthy"
      && payload.dependencies.ollama?.state === "healthy"
        ? "healthy"
        : "degraded";

    const cutMcpDep = payload.dependencies.teminaliCutMcp;

    return {
      state: overallState,
      gateway: {
        state: payload.gateway.state,
        latencyMs: 0,
        detail: `Loopback gateway bound to ${payload.gateway.bind}`,
        checkedAt: payload.timestamp,
      },
      ollama: toServiceHealth("Ollama", payload.dependencies.ollama),
      teminaliCutMcp: toServiceHealth("Teminali Cut MCP", cutMcpDep),
      models: [],
    };
  }

  public static async getFrontierStatus(): Promise<FrontierModeStatus> {
    const response = await this.request("/api/frontier/status", { method: "GET" });
    await this.expectOk(response);
    return (await response.json()) as FrontierModeStatus;
  }

  public static async resolveModelMode(mode: ModelModeId, prompt: string): Promise<FrontierModelSelection> {
    const response = await this.request("/api/frontier/resolve-mode", {
      method: "POST",
      body: JSON.stringify({ mode, prompt }),
    });
    await this.expectOk(response);
    return (await response.json()) as FrontierModelSelection;
  }

  public static async recordAudit(event: Record<string, unknown>): Promise<void> {
    try {
      const response = await this.request("/api/audit", {
        method: "POST",
        body: JSON.stringify(event),
      });
      await this.expectOk(response);
    } catch {
      // Audit transport failure must not turn a completed model request into a false failure.
    }
  }
}
