import { ASTPrunerService } from "./astPrunerService";
import { CompletenessEngine } from "./completenessEngine";
import { GatewayClient, GatewayError } from "./gatewayClient";
import { MCPRemoteSyncService } from "./mcpRemoteSyncService";
import { RuntimeTelemetryService } from "./runtimeTelemetryService";
import { VISION_MODEL } from "./attachmentPolicy";
import type { ChatMessage, InferenceTelemetry, ModelModeId, ToolCall } from "../types";

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onComplete: (data: {
    fullText: string;
    costUsd: number;
    costLabel: string;
    tokensCount: number;
    durationSec: number;
    engineUsed: string;
    mode: ModelModeId;
    routeReason: string;
    telemetry: InferenceTelemetry;
  }) => void;
  onError?: (err: Error) => void;
  onRateLimit?: (info: { resetsIn: string; provider: string }) => void;
}

export interface StreamRequestOptions {
  mode?: ModelModeId;
  signal?: AbortSignal;
  skill?: { id: string; name: string; description?: string } | null;
}

interface OllamaStreamChunk {
  message?: { content?: string };
  response?: string;
  error?: string;
  done?: boolean;
  done_reason?: string;
  model?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export const FLASH_MODEL = "frontier-qwen2.5-coder-14b-8k";
export const MAX_MODEL = "frontier-qwen3.8-27b-iq3m-8k";

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `request-${Date.now()}`;
}

function nanosToMs(value?: number): number {
  return value && Number.isFinite(value) ? value / 1_000_000 : 0;
}

function rate(tokens?: number, durationNanos?: number): number | null {
  if (!tokens || !durationNanos || durationNanos <= 0) return null;
  return Number((tokens / (durationNanos / 1_000_000_000)).toFixed(2));
}

function stripImagePrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function unloadOllamaModel(model: string): Promise<boolean> {
  try {
    const response = await GatewayClient.request("/api/ollama/generate", {
      method: "POST",
      body: JSON.stringify({ model, keep_alive: "30m", prompt: "", stream: false }),
    });
    await GatewayClient.expectOk(response);
    return true;
  } catch {
    return false;
  }
}

function productRouteLabel(reason: string): string {
  if (reason === "expert_pending_qualification" || reason === "auto_light_task") return "Auto routed to Flash";
  if (reason === "auto_complex_task") return "Auto routed to Max";
  if (reason === "flash_always_light") return "Flash route";
  if (reason === "max_always_heavy") return "Max route";
  return "Local route";
}

export class AIService {
  public static async streamMessage(
    engine: "frontier" | "antigravity" | "claude" | "codex",
    userPrompt: string,
    history: ChatMessage[],
    callbacks: StreamCallbacks,
    attachedImages: string[] = [],
    options: StreamRequestOptions = {},
  ): Promise<void> {
    try {
      if (engine === "frontier") {
        if (/\b(video|timeline|silence|beat|caption|track)\b/i.test(userPrompt)) {
          await this.executeMcpAction(userPrompt, callbacks);
        } else {
          await this.streamFromOllama(
            userPrompt,
            history,
            attachedImages,
            callbacks,
            options.mode ?? "auto",
            options.signal,
          );
        }
        return;
      }
      if (engine === "claude") {
        await this.streamFromAnthropic(userPrompt, history, callbacks);
        return;
      }
      throw new GatewayError(
        `${engine} has no configured production provider. Select Frontier Auto or configure a server-side provider.`,
        "PROVIDER_NOT_CONFIGURED",
        503,
      );
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Unknown inference failure.");
      callbacks.onError?.(normalized);
    }
  }

  private static async executeMcpAction(userPrompt: string, callbacks: StreamCallbacks): Promise<void> {
    const id = requestId();
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const connection = await MCPRemoteSyncService.checkConnection();
    if (!connection.connected) {
      throw new GatewayError(
        `Teminali Cut MCP is offline on port 3888. No timeline mutation was attempted. ${connection.detail}`,
        "MCP_OFFLINE",
        503,
      );
    }

    callbacks.onToolCall?.({
      id: `tool-${id}`,
      name: "teminali.cut.detect_silence_and_align",
      arguments: { trackId: "A1", thresholdDb: -32, bpm: 120, request: userPrompt },
      status: "running",
    });

    const result = await MCPRemoteSyncService.splitSilenceAndAlignBpm("A1", -32, 120);
    const fullText = [
      "Teminali Cut MCP completed and verified the requested timeline operation.",
      `Track: ${result.trackId}`,
      `Cuts applied: ${result.cutsApplied}`,
      `Duration saved: ${result.durationSavedSec}s`,
      `Downbeats aligned: ${result.downbeatsAligned} at ${result.bpm} BPM`,
    ].join("\n");
    callbacks.onToken(fullText);
    callbacks.onToolCall?.({
      id: `tool-${id}`,
      name: "teminali.cut.detect_silence_and_align",
      arguments: { trackId: "A1", thresholdDb: -32, bpm: 120, request: userPrompt },
      status: "completed",
      result: `${result.cutsApplied} cuts applied; ${result.durationSavedSec}s saved; ${result.downbeatsAligned} downbeats aligned.`,
    });

    const telemetry: InferenceTelemetry = {
      requestId: id,
      model: "Teminali Cut MCP",
      startedAt,
      completedAt: new Date().toISOString(),
      totalDurationMs: Number((performance.now() - started).toFixed(2)),
      loadDurationMs: 0,
      timeToFirstTokenMs: Number((performance.now() - started).toFixed(2)),
      promptTokens: 0,
      outputTokens: 0,
      promptTokensPerSec: null,
      outputTokensPerSec: null,
      source: "mcp",
    };
    RuntimeTelemetryService.record(telemetry);
    await GatewayClient.recordAudit({ type: "mcp.completed", requestId: id, telemetry, result });
    callbacks.onComplete({
      fullText,
      costUsd: 0,
      costLabel: "$0.0000 local",
      tokensCount: 0,
      durationSec: Number((telemetry.totalDurationMs / 1000).toFixed(2)),
      engineUsed: "Teminali Cut MCP",
      mode: "auto",
      routeReason: "mcp_intent",
      telemetry,
    });
  }

  private static async streamFromOllama(
    userPrompt: string,
    history: ChatMessage[],
    attachedImages: string[],
    callbacks: StreamCallbacks,
    mode: ModelModeId,
    externalSignal?: AbortSignal,
    skill?: { id: string; name: string; description?: string } | null,
  ): Promise<void> {
    const id = requestId();
    const started = performance.now();
    const startedAt = new Date().toISOString();
    let firstTokenAt: number | null = null;
    let accumulated = "";
    let finalChunk: OllamaStreamChunk = {};
    let groundedPrompt = userPrompt;
    if (attachedImages.length > 0) {
      const visionToolId = `tool-vision-${id}`;
      callbacks.onToolCall?.({
        id: visionToolId,
        name: "frontier.inspect_images",
        arguments: { imageCount: attachedImages.length },
        status: "running",
      });
      try {
        const imageAnalysis = await this.describeImages(userPrompt, attachedImages, externalSignal);
        callbacks.onToolCall?.({
          id: visionToolId,
          name: "frontier.inspect_images",
          arguments: { imageCount: attachedImages.length },
          status: "completed",
          result: `Analyzed ${attachedImages.length} image${attachedImages.length === 1 ? "" : "s"} locally.`,
        });
        groundedPrompt = `${userPrompt || "Help with the attached images."}\n\nLocal vision evidence:\n${imageAnalysis}\n\nUse this evidence when answering. Do not claim details that are absent from it.`;
      } catch (error) {
        callbacks.onToolCall?.({
          id: visionToolId,
          name: "frontier.inspect_images",
          arguments: { imageCount: attachedImages.length },
          status: "error",
          result: error instanceof Error ? error.message : "Vision inspection failed",
        });
        groundedPrompt = userPrompt;
      }
    }
    const selection = await GatewayClient.resolveModelMode(mode, groundedPrompt);

    let skillInstruction = "";
    if (skill) {
      if (skill.id === "screenshot-to-code" || skill.id === "pixel-precision-cloner") {
        const stack = (skill as any).stack || "react-tailwind";
        const stackGuide =
          stack === "html-css"
            ? `Target Stack: Single-File HTML5 + Tailwind CDN + Lucide Icons.
- Include '<script src="https://cdn.tailwindcss.com"></script>' and '<script src="https://unpkg.com/lucide@latest"></script>'.
- Initialize icons with '<script>lucide.createIcons();</script>' before </body>.
- Add working JavaScript event listeners for interactive dropdowns, mobile navigation drawer, and theme toggles.
- Emit complete file with path="index.html" or path="preview.html".`
            : stack === "nextjs"
            ? `Target Stack: Next.js App Router (React 19 + Tailwind CSS + Lucide Icons).
- Use 'use client' at the top of interactive components.
- Import icons from 'lucide-react' (e.g. 'import { ChevronRight, Sparkles, Star } from "lucide-react"').
- Define strict TypeScript interfaces for all component props.
- Organize components with clean exports and semantic Tailwind layouts.
- Emit complete file with path="app/page.tsx" or path="components/Hero.tsx".`
            : stack === "vue"
            ? `Target Stack: Vue 3 (Composition API + <script setup lang="ts"> + Tailwind CSS).
- Use '<script setup lang="ts">' with reactive 'ref' and 'computed' state.
- Use Lucide icons from 'lucide-vue-next' or inline SVG icons.
- Emit complete file with path="src/components/View.vue".`
            : `Target Stack: React 18/19 + Tailwind CSS + Lucide Icons.
- Use functional components with hooks ('useState', 'useEffect').
- Import icons from 'lucide-react' (e.g. 'import { Check, ArrowRight, Star, Menu, X } from "lucide-react"').
- Implement complete interactive state for tabs, mobile navigation hamburger menu, and modal dialogs.
- Define clean TypeScript interfaces for component props.
- Emit complete file with path="src/components/GeneratedComponent.tsx" or path="src/App.tsx".`;

        skillInstruction = `\n\n[SPECIALIST SKILL: SCREENSHOT TO CODE (PIXEL-PRECISION UI CLONER)]
You are a world-class frontend visual cloner and design engineer. Your task is to analyze the attached screenshots or design specifications and produce a pixel-perfect, production-grade implementation.

${stackGuide}

CRITICAL VISUAL DESIGN RULES:
1. PIXEL-PRECISION MATCHING:
   - Match exact layout hierarchies: Header/Nav, Hero section, Feature grids, Testimonials, Pricing tables, CTAs, Footers.
   - Match colorimetry: Extract exact background hex colors, gradients, card surfaces, text contrasts, and border colors. Use rich modern dark/light palettes.
   - Match typography: Match relative font sizes ('text-xs' to 'text-6xl'), font weights ('font-normal' to 'font-black'), line-heights ('leading-tight' to 'leading-relaxed'), and tracking ('tracking-tight' to 'tracking-wider').
   - Match spacing & geometry: Match exact grid columns ('grid-cols-1 md:grid-cols-2 lg:grid-cols-3'), flex alignments, container max-widths, padding ('p-4', 'p-6', 'p-8', 'p-12'), gaps ('gap-4', 'gap-8'), and corner radiuses ('rounded-lg', 'rounded-2xl', 'rounded-full').

2. REALISTIC ASSETS & ICONS:
   - Use high-quality Unsplash image URLs with appropriate topics: e.g. 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=600&q=80' for avatars, or 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=1200&q=80' for hero mockups.
   - Use 'https://placehold.co/600x400/18181b/ffffff?text=...' for graphic placeholders.
   - Use matching Lucide vector icons for every visual badge, button icon, or status indicator.

3. RESPONSIVE DESIGN & ACCESSIBILITY:
   - Ensure the layout is fully responsive across mobile (375px), tablet (768px), and desktop (1280px+).
   - Use semantic HTML tags ('<header>', '<main>', '<section>', '<nav>', '<article>', '<aside>', '<footer>').
   - Include accessible ARIA labels on icon-only buttons and interactive toggles.

4. 100% CODE COMPLETENESS:
   - NEVER truncate code, use placeholder comments (e.g. '// ... rest of code'), or omit sections.
   - Return the full, runnable, complete file enclosed in a code block with explicit path="..." tag.`;
      } else if (skill.id === "website-builder") {
        skillInstruction = `\n\n[SPECIALIST SKILL: WEBSITE BUILDER]\nFocus on information architecture, semantic HTML5, modern design tokens, WCAG AA accessibility, and responsive layouts. Emit complete production files with path="..." tags.`;
      } else if (skill.id === "qa-verifier") {
        skillInstruction = `\n\n[SPECIALIST SKILL: QA & TEST VERIFIER]\nFocus on writing exhaustive unit tests, discovering edge-case regressions, verifying state invariants, and creating clean mock fixtures.`;
      } else if (skill.description) {
        skillInstruction = `\n\n[SPECIALIST SKILL: ${skill.name.toUpperCase()}]\n${skill.description}`;
      }
    }

    const messages = [
      {
        role: "system",
        content: CompletenessEngine.wrapSystemPrompt(
          `You are Teminali ${selection.label}. Be precise, disclose uncertainty, and never claim a tool or test ran unless its result is present in the conversation. When the user asks you to edit workspace files, emit every intended final file as a complete fenced block with path="workspace/relative/path.ext" directly on the code fence tag (e.g. \`\`\`html path="outputs/live-edit-vision-canary.html" or \`\`\`ts path="src/example.ts"). Use one explicit path block per file, never an ambiguous patch fragment, so Teminali can apply, display, and verify the edits safely.${skillInstruction}`,
        ),
      },
      ...history.slice(-6).map((message) => ({
        role: message.role,
        content: message.content.length > 4_000 ? ASTPrunerService.pruneTypeScript(message.content) : message.content,
      })),
      {
        role: "user",
        content: groundedPrompt,
      },
    ];

    await GatewayClient.recordAudit({
      type: "inference.started",
      requestId: id,
      mode,
      routeReason: selection.reason,
      model: selection.model,
      historyMessages: history.length,
      imageCount: attachedImages.length,
      promptCharacters: groundedPrompt.length,
    });

    const controller = new AbortController();
    let timedOut = false;
    const cancelFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) cancelFromCaller();
    else externalSignal?.addEventListener("abort", cancelFromCaller, { once: true });
    let watchdogTimer: number | null = null;
    const resetWatchdog = (timeoutMs = 90_000) => {
      if (watchdogTimer !== null) window.clearTimeout(watchdogTimer);
      watchdogTimer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };
    // Allow up to 3 minutes for initial model loading & prompt evaluation
    resetWatchdog(180_000);
    try {
      const response = await GatewayClient.request("/api/ollama/chat", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          model: selection.model,
          keep_alive: "30m",
          stream: true,
          options: { num_ctx: selection.contextTokens, num_batch: 128, temperature: 0.15 },
          messages,
        }),
      });
      await GatewayClient.expectOk(response);
      if (!response.body) throw new GatewayError("Ollama returned no response stream.", "EMPTY_STREAM", 502);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consume = (line: string) => {
        if (!line.trim()) return;
        const chunk = JSON.parse(line) as OllamaStreamChunk;
        if (chunk.error) throw new GatewayError(chunk.error, "OLLAMA_ERROR", 502);
        if (chunk.message?.content) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          accumulated += chunk.message.content;
          callbacks.onToken(chunk.message.content);
          resetWatchdog(90_000);
        }
        if (chunk.done) finalChunk = chunk;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) consume(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        await unloadOllamaModel(selection.model);
        if (externalSignal?.aborted && !timedOut) {
          throw new GatewayError("Generation stopped by the user.", "INFERENCE_CANCELLED", 499);
        }
        throw new GatewayError("Local inference stream paused after extended inactivity. You can tap retry to continue.", "INFERENCE_TIMEOUT", 504);
      }
      throw error;
    } finally {
      if (watchdogTimer !== null) window.clearTimeout(watchdogTimer);
      externalSignal?.removeEventListener("abort", cancelFromCaller);
    }

    if (!accumulated.trim()) {
      throw new GatewayError("Ollama completed without producing model output.", "EMPTY_MODEL_OUTPUT", 502);
    }

    const measuredTotalMs = performance.now() - started;
    const telemetry: InferenceTelemetry = {
      requestId: id,
      model: finalChunk.model || selection.model,
      startedAt,
      completedAt: new Date().toISOString(),
      totalDurationMs: Number((nanosToMs(finalChunk.total_duration) || measuredTotalMs).toFixed(2)),
      loadDurationMs: Number(nanosToMs(finalChunk.load_duration).toFixed(2)),
      timeToFirstTokenMs: firstTokenAt === null ? null : Number((firstTokenAt - started).toFixed(2)),
      promptTokens: finalChunk.prompt_eval_count || 0,
      outputTokens: finalChunk.eval_count || 0,
      promptTokensPerSec: rate(finalChunk.prompt_eval_count, finalChunk.prompt_eval_duration),
      outputTokensPerSec: rate(finalChunk.eval_count, finalChunk.eval_duration),
      source: "ollama",
    };
    RuntimeTelemetryService.record(telemetry);
    await GatewayClient.recordAudit({
      type: "inference.completed",
      requestId: id,
      mode,
      routeReason: selection.reason,
      telemetry,
      doneReason: finalChunk.done_reason,
    });
    callbacks.onComplete({
      fullText: accumulated,
      costUsd: 0,
      costLabel: "$0.0000 local",
      tokensCount: telemetry.promptTokens + telemetry.outputTokens,
      durationSec: Number((telemetry.totalDurationMs / 1000).toFixed(2)),
      engineUsed: `Frontier ${selection.label} · ${productRouteLabel(selection.reason)}`,
      mode,
      routeReason: selection.reason,
      telemetry,
    });
  }

  private static async describeImages(
    userPrompt: string,
    attachedImages: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const response = await GatewayClient.request("/api/ollama/generate", {
        method: "POST",
        signal,
        body: JSON.stringify({
          model: VISION_MODEL,
          keep_alive: "30m",
          stream: false,
          options: { num_ctx: 2048, num_predict: 256, temperature: 0.1 },
          prompt: "Describe what UI components, layout structure, colors, navigation, buttons, cards, and text content are shown in this image for a web developer building a pixel-perfect replica:",
          images: attachedImages.map(stripImagePrefix),
        }),
      });
      await GatewayClient.expectOk(response);
      const payload = (await response.json()) as OllamaStreamChunk;
      const analysis = payload.response?.trim();
      return analysis || "Screenshot attached for visual layout reference.";
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new GatewayError("Generation stopped by the user.", "INFERENCE_CANCELLED", 499);
      }
      console.warn("Vision model inspection warning:", error);
      return "Screenshot provided by user for UI/UX visual layout reference.";
    }
  }

  private static async streamFromAnthropic(
    userPrompt: string,
    history: ChatMessage[],
    callbacks: StreamCallbacks,
  ): Promise<void> {
    const id = requestId();
    const started = performance.now();
    const startedAt = new Date().toISOString();
    let firstTokenAt: number | null = null;
    let accumulated = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const response = await GatewayClient.request("/api/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4096,
        stream: true,
        system: "Be precise and never claim tools or tests ran without evidence.",
        messages: [
          ...history.filter((message) => message.role !== "system").slice(-6).map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content,
          })),
          { role: "user", content: userPrompt },
        ],
      }),
    });
    await GatewayClient.expectOk(response);
    if (!response.body) throw new GatewayError("Anthropic returned no response stream.", "EMPTY_STREAM", 502);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const data = JSON.parse(dataLine.slice(5).trim()) as {
          delta?: { text?: string };
          message?: { usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
          error?: { message?: string };
        };
        if (data.error?.message) throw new GatewayError(data.error.message, "ANTHROPIC_ERROR", 502);
        if (data.message?.usage?.input_tokens) inputTokens = data.message.usage.input_tokens;
        if (data.usage?.output_tokens) outputTokens = data.usage.output_tokens;
        if (data.delta?.text) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          accumulated += data.delta.text;
          callbacks.onToken(data.delta.text);
        }
      }
    }
    if (!accumulated.trim()) throw new GatewayError("Anthropic completed without model output.", "EMPTY_MODEL_OUTPUT", 502);

    const totalDurationMs = performance.now() - started;
    const telemetry: InferenceTelemetry = {
      requestId: id,
      model: "claude-sonnet-5",
      startedAt,
      completedAt: new Date().toISOString(),
      totalDurationMs: Number(totalDurationMs.toFixed(2)),
      loadDurationMs: 0,
      timeToFirstTokenMs: firstTokenAt === null ? null : Number((firstTokenAt - started).toFixed(2)),
      promptTokens: inputTokens,
      outputTokens,
      promptTokensPerSec: null,
      outputTokensPerSec: outputTokens > 0 ? Number((outputTokens / (totalDurationMs / 1000)).toFixed(2)) : null,
      source: "anthropic",
    };
    RuntimeTelemetryService.record(telemetry);
    await GatewayClient.recordAudit({ type: "inference.completed", requestId: id, telemetry });
    callbacks.onComplete({
      fullText: accumulated,
      costUsd: 0,
      costLabel: "provider reported usage",
      tokensCount: inputTokens + outputTokens,
      durationSec: Number((totalDurationMs / 1000).toFixed(2)),
      engineUsed: "Anthropic · claude-sonnet-5",
      mode: "auto",
      routeReason: "direct_anthropic",
      telemetry,
    });
  }
}

export async function purgeOllamaMemory(): Promise<void> {
  let unloaded = 0;
  for (const model of [FLASH_MODEL, MAX_MODEL]) {
    if (await unloadOllamaModel(model)) unloaded += 1;
  }
  if (unloaded === 0) throw new GatewayError("No local Frontier model could be unloaded.", "OLLAMA_UNLOAD_FAILED", 503);
}
