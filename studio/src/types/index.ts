export type ModelModeId = "flash" | "auto" | "max";
export type ModelProfileId = ModelModeId;

export interface ModelProfile {
  id: ModelProfileId;
  name: string;
  provider: "ollama" | "anthropic" | "gemini" | "hybrid";
  modelName: string;
  costLabel: string;
  badge: string;
  badgeColor: string;
  description: string;
}

export interface SpecialistSkill {
  id: string;
  name: string;
  tagline: string;
  icon: string;
  description: string;
  starterPrompts: string[];
  /**
   * Which half of the app the skill belongs to. There is one catalogue now —
   * the IDE skills and the video skills are one list, grouped by this — so a
   * skill has to say which group it falls in rather than being implied by
   * which surface happened to be showing it.
   */
  category: "code" | "video";
}

export interface FileItem {
  id: string;
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileItem[];
  size?: number;
  modified?: string;
  content?: string;
  isDirty?: boolean;
}

export interface EditorTab {
  id: string;
  name: string;
  path: string;
  language: string;
  content: string;
  isDirty: boolean;
  encoding?: "utf8" | "base64";
  mimeType?: string;
  size?: number;
  modified?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
  diff?: {
    file: string;
    additions: number;
    deletions: number;
    diffText: string;
  };
}

export interface ChatMessage {
  images?: string[];
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  costUsd?: number;
  costLabel?: string;
  tokensCount?: number;
  durationSec?: number;
  /**
   * Of `durationSec`, the seconds spent loading the model's weights. Only the
   * local lane has a cold start; the row names it only when it is large enough
   * to change what `durationSec` means — see `utils/messageTelemetry.ts`.
   */
  loadSec?: number;
  /**
   * System-prompt sections this turn's window could not afford. The row names
   * only the ones whose loss changed what the model could do — see
   * `droppedWorthNaming` in `utils/messageTelemetry.ts`.
   */
  droppedSections?: string[];
  engineUsed?: string;
  mode?: ModelModeId;
  routeReason?: string;
  cancelled?: boolean;
  telemetry?: InferenceTelemetry;
  errorCode?: string;
}

export type RuntimeState = "healthy" | "degraded" | "offline" | "demo" | "checking";

export interface ServiceHealth {
  state: RuntimeState;
  latencyMs: number | null;
  detail: string;
  checkedAt: string;
}

export interface RuntimeHealthReport {
  state: RuntimeState;
  gateway: ServiceHealth;
  ollama: ServiceHealth;
  teminaliCutMcp: ServiceHealth;
  models: string[];
}

export interface InferenceTelemetry {
  requestId: string;
  model: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  loadDurationMs: number;
  timeToFirstTokenMs: number | null;
  promptTokens: number;
  outputTokens: number;
  promptTokensPerSec: number | null;
  outputTokensPerSec: number | null;
  source: "ollama" | "anthropic" | "mcp" | "ui-command" | "agent-cli";
  /**
   * How the turn's prompt was fitted to the model's window. Present only on
   * lanes Teminali governs; a CLI lane manages its own context and reports none.
   */
  contextBudget?: {
    windowTokens: number;
    systemPromptChars: number;
    /** Prompt sections the window could not afford, most important first. */
    dropped: string[];
  };
}
