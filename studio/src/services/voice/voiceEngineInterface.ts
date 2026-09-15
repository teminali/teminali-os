/**
 * Teminali OS — Unified Voice Engine Interface
 *
 * Defines the shared contract between the Online (Gemini Live) and
 * Local (100% Offline Fallback) voice engines.
 */

export type VoiceEngineMode = "online" | "local";

export interface VoiceEngineStatus {
  mode: VoiceEngineMode;
  connected: boolean;
  listening: boolean;
  speaking: boolean;
  latencyMs?: number;
  modelName?: string;
  error?: string | null;
}

export interface VoiceEngineTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  tokensUsed: number;
  latencyMs: number;
  timestamp: number;
  isFastPath?: boolean;
}

export interface IVoiceEngine {
  readonly mode: VoiceEngineMode;
  readonly isConnected: boolean;
  readonly isListening: boolean;
  readonly isSpeaking: boolean;

  connect(): Promise<void>;
  disconnect(): void;
  startListening(): void;
  stopListening(): void;
  sendBargeIn(): void;
  submitUserText(text: string): Promise<void>;

  speakText(
    text: string,
    options?: { priority?: "normal" | "urgent"; onComplete?: () => void }
  ): Promise<void>;

  onTurn?: (turn: VoiceEngineTurn) => void;
  onStatusChange?: (status: VoiceEngineStatus) => void;
  onError?: (error: Error) => void;
}
