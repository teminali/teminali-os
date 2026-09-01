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
}

export interface ExtensionItem {
  id: string;
  name: string;
  displayName: string;
  publisher: string;
  version: string;
  downloads: string;
  rating: number;
  ratingCount: number;
  description: string;
  category: "Formatters" | "Linters" | "Languages" | "Themes" | "AI & MCP" | "Tools";
  iconBg: string;
  iconText: string;
  installed: boolean;
  enabled: boolean;
  readme: string;
  settings?: Record<string, { type: string; default: any; description: string }>;
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
  isExtensionDetail?: boolean;
  extensionData?: ExtensionItem;
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
  source: "ollama" | "anthropic" | "mcp" | "ui-command";
}
