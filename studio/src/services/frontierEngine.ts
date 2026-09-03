/**
 * Frontier Engine — the model engineering wrapper.
 *
 * Owns routing, prompt assembly, streaming, telemetry, and the agent loop.
 * It speaks the model's protocols (file fences, run fences) and reviews model
 * output, but it holds no editor code: anything the host can *do* — running a
 * command, asking a human — arrives through EngineCapabilities.
 *
 * That separation is what lets the engine be benchmarked and reasoned about on
 * its own, and keeps editor faults from being scored against the model.
 */
import { ASTPrunerService } from "./astPrunerService";
import { CompletenessEngine } from "./completenessEngine";
import { DiligenceEngine } from "./diligenceEngine";
import { parseWorkspaceEdits } from "./liveEditProtocol";
import { GatewayClient, GatewayError } from "./gatewayClient";
import { RuntimeTelemetryService } from "./runtimeTelemetryService";
import { VISION_MODEL } from "./attachmentPolicy";
import {
  buildCommandEvidence,
  hasExecutableCommands,
  runAgentCommands,
  type AgentCommandRequest,
  type CommandExecution,
  type CommandExecutor,
} from "./agentCommands";
import {
  buildVideoToolEvidence,
  hasVideoToolCalls,
  runVideoToolCalls,
  type VideoToolExecutor,
} from "./videoToolCalls";
import type { ChatMessage, InferenceTelemetry, ModelModeId, ToolCall } from "../types";

/** What the host lets the engine do. Absent capabilities simply stay unused. */
export interface EngineCapabilities {
  /** Executes a workspace command and reports its real result. */
  runCommand?: CommandExecutor;
  /**
   * The editor tools the host exposes, for the prompt to advertise.
   *
   * Injected rather than imported, for the same reason the executor is: the
   * engine must not know that a video panel exists, only that this host
   * happens to offer some tools and what to call them.
   */
  videoTools?: VideoToolSummary[];
  /** Runs one editor tool and reports its real result. */
  runVideoTool?: VideoToolExecutor;
}

/** One line of the editor tool catalogue, already flattened by the host. */
export interface VideoToolSummary {
  name: string;
  description: string;
  /** Argument names in declaration order, optional ones suffixed with "?". */
  parameters: string[];
}

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

// Correction turns re-emit whole files, so on a 9 t/s local model each one is
// expensive and three is the ceiling worth paying for.
const MAX_AGENT_COMMAND_TURNS = 3;
// Investigation turns are a different economy: they emit a few commands and no
// files, so one costs a fraction of a correction pass. Answering "what is
// taking the space" honestly means total -> breakdown -> drill in -> verify,
// which is already four sequential rounds; budgeting them like generation
// turns is what forced the model to guess at step three.
const MAX_INVESTIGATION_TURNS = 8;
// Editor tool turns are the cheapest of the three: no files are re-emitted and
// the results are JSON read out of the renderer's own memory. Six because an
// editing exchange is describe -> edit -> verify, and "make the title bigger
// and warmer" is already two edits inside that.
const MAX_EDITOR_TOOL_TURNS = 6;
// Belt and braces: no combination of the budgets below may loop forever.
const MAX_TOTAL_TURNS = MAX_AGENT_COMMAND_TURNS + MAX_INVESTIGATION_TURNS + MAX_EDITOR_TOOL_TURNS + 2;
// One self-correction pass by default: on a 9 t/s local model each pass
// re-emits whole files, so a second costs more wall-clock than it returns.
const MAX_QUALITY_CORRECTIONS = 1;
// The investigation audit only ever asks once. If the model will not ground its
// answer after being told exactly what is missing, another pass will not help.
const MAX_DILIGENCE_CORRECTIONS = 1;
// When every command in a turn was blocked or declined, the model is told once.
// Told nothing, it re-emits the same command and the user is asked to approve
// the same thing twice; told repeatedly, it argues with the approval gate.
const MAX_DENIED_FEEDBACK = 1;

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
    // keep_alive must be 0 to evict the model. Any positive duration extends
    // residency instead of releasing it, which silently defeats purgeOllamaMemory()
    // and the post-cancel VRAM release on unified-memory Macs.
    const response = await GatewayClient.request("/api/ollama/generate", {
      method: "POST",
      body: JSON.stringify({ model, keep_alive: 0, prompt: "", stream: false }),
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

async function streamFromOllama(
  userPrompt: string,
  history: ChatMessage[],
  attachedImages: string[],
  callbacks: StreamCallbacks,
  mode: ModelModeId,
  externalSignal?: AbortSignal,
  skill?: { id: string; name: string; description?: string } | null,
  approveCommand?: (request: AgentCommandRequest) => Promise<boolean>,
  capabilities: EngineCapabilities = {},
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
      const imageAnalysis = await describeImages(userPrompt, attachedImages, externalSignal);
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

  /*
    What the model is told about the video panel.
    Empty when the host exposes no editor tools, so a headless caller and the
    benchmark arena get the prompt they got before this existed.
  */
  let editorInstruction = "";
  if (capabilities.videoTools && capabilities.videoTools.length > 0) {
    const toolList = capabilities.videoTools
      .map((tool) => `- ${tool.name}(${tool.parameters.join(", ")}), ${tool.description}`)
      .join("\n");
    editorInstruction = `\n\n[TEMINALI CUT PANEL]\nThe video editor is part of this workspace and you can edit the user's timeline directly. To call an editor tool, emit a \`\`\`video-tool fence holding one JSON object, or an array of them, shaped {"tool":"name","arguments":{...}}; its real result is returned to you before you answer again. A \`\`\`json block is documentation and is never executed. Call describe_timeline before any edit and address clips by the ids it returns, never by an id you invented, and never report an edit whose result is not in the conversation. Times are milliseconds. Every call lands on the timeline the user is watching, and each one is a single undo.\nEDITOR TOOLS:\n${toolList}`;
  }

  const messages = [
    {
      role: "system",
      content: DiligenceEngine.wrapSystemPrompt(CompletenessEngine.wrapSystemPrompt(
        `You are Teminali ${selection.label}. Be precise, disclose uncertainty, and never claim a tool or test ran unless its result is present in the conversation. When the user asks you to edit workspace files, emit every intended final file as a complete fenced block with path="workspace/relative/path.ext" directly on the code fence tag (e.g. \`\`\`html path="outputs/live-edit-vision-canary.html" or \`\`\`ts path="src/example.ts"). Use one explicit path block per file, never an ambiguous patch fragment, so Teminali can apply, display, and verify the edits safely. To actually run a workspace command, emit it in a \`\`\`frontier-run fence (one command per line); its real output is returned to you before you answer again. A \`\`\`bash or \`\`\`sh block is documentation and is never executed. Read-only checks such as npm test, npx tsc, and git status run automatically; anything that changes state waits for the user, so never assume it ran.${skillInstruction}${editorInstruction}`,
      )),
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
  const runTurn = async (turnMessages: Array<{ role: string; content: string }>): Promise<string> => {
    const startedLength = accumulated.length;
    // Allow up to 3 minutes for initial model loading & prompt evaluation
    resetWatchdog(180_000);
    const response = await GatewayClient.request("/api/ollama/chat", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        model: selection.model,
        keep_alive: "30m",
        stream: true,
        options: { num_ctx: selection.contextTokens, num_batch: 128, temperature: 0.15 },
        messages: turnMessages,
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
    return accumulated.slice(startedLength);
  };

  try {
    let turnMessages: Array<{ role: string; content: string }> = messages;
    let turnText = await runTurn(turnMessages);

    // Agent loop. Each pass either executes a command the model asked for and
    // returns its real output, or reviews the files it just wrote and returns
    // the defects. Bounded so a model cannot loop indefinitely.
    let qualityCorrections = 0;
    let diligenceCorrections = 0;
    let investigationTurns = 0;
    let editorTurns = 0;
    let correctionTurns = 0;
    let deniedFeedback = 0;
    // Every command run this exchange. The investigation audit needs the whole
    // history, not just the last turn's, to tell "measured then answered" from
    // "measured once, then guessed at the part that mattered".
    const allExecutions: CommandExecution[] = [];

    for (let iteration = 0; iteration < MAX_TOTAL_TURNS; iteration += 1) {
      if (controller.signal.aborted) break;

      let observation = "";
      let investigated = false;

      if (capabilities.runCommand && hasExecutableCommands(turnText) && investigationTurns < MAX_INVESTIGATION_TURNS) {
        const executions = await runAgentCommands(turnText, {
          execute: capabilities.runCommand!,
          signal: controller.signal,
          onToolCall: callbacks.onToolCall,
          approve: approveCommand,
        });
        allExecutions.push(...executions);
        if (executions.some((execution) => execution.executed)) {
          observation = buildCommandEvidence(executions);
          investigated = true;
        } else if (executions.length > 0 && deniedFeedback < MAX_DENIED_FEEDBACK) {
          // Nothing ran: every command was blocked or the user declined it.
          // buildCommandEvidence renders that as "# not run — <reason>", which
          // is the only way the model learns the difference between a command
          // that failed and one it never got to try.
          observation = buildCommandEvidence(executions);
          deniedFeedback += 1;
          investigated = true;
        }
      }

      if (capabilities.runVideoTool && hasVideoToolCalls(turnText) && editorTurns < MAX_EDITOR_TOOL_TURNS) {
        const executions = await runVideoToolCalls(turnText, {
          execute: capabilities.runVideoTool,
          signal: controller.signal,
          onToolCall: callbacks.onToolCall,
        });
        if (executions.length > 0) {
          // Appended, not substituted. A turn may both run a command and edit
          // the timeline, and dropping either observation leaves the model
          // repeating the half it was never told the result of.
          const evidence = buildVideoToolEvidence(executions);
          observation = observation ? `${observation}\n\n${evidence}` : evidence;
          editorTurns += 1;
          // Editor results are real evidence, so they buy an investigation
          // turn rather than a correction one — the same as a command's output.
          investigated = true;
        }
      }

      if (!observation && qualityCorrections < MAX_QUALITY_CORRECTIONS && correctionTurns < MAX_AGENT_COMMAND_TURNS) {
        const written = parseWorkspaceEdits(turnText, { userPrompt: groundedPrompt })
          .filter((edit) => edit.complete)
          .map((edit) => ({ path: edit.path, content: edit.content }));
        if (written.length > 0) {
          const findings = CompletenessEngine.auditGeneratedFiles(written);
          if (findings.length > 0) {
            const reviewId = `tool-review-${id}-${iteration}`;
            callbacks.onToolCall?.({
              id: reviewId,
              name: "frontier.review_output",
              arguments: { files: written.length },
              status: "completed",
              result: `${findings.length} issue${findings.length === 1 ? "" : "s"} found; requesting a correction pass.`,
            });
            observation = CompletenessEngine.formatAuditBrief(findings);
            qualityCorrections += 1;
          }
        }
      }

      // Last gate before delivery. The model has stopped asking for anything, so
      // the text in hand is the answer the user will read; this is the only
      // point at which "you never actually looked" is still correctable.
      if (!observation && diligenceCorrections < MAX_DILIGENCE_CORRECTIONS && correctionTurns < MAX_AGENT_COMMAND_TURNS) {
        const findings = DiligenceEngine.auditInvestigation({
          userPrompt: groundedPrompt,
          answerText: turnText,
          executions: allExecutions,
          canRunCommands: Boolean(capabilities.runCommand),
        });
        if (findings.length > 0) {
          const auditId = `tool-diligence-${id}-${iteration}`;
          callbacks.onToolCall?.({
            id: auditId,
            name: "frontier.review_investigation",
            arguments: { commandsRun: allExecutions.filter((execution) => execution.executed).length },
            status: "completed",
            result: `${findings.length} evidence gap${findings.length === 1 ? "" : "s"} found; requesting a grounded pass.`,
          });
          observation = DiligenceEngine.formatDiligenceBrief(findings);
          diligenceCorrections += 1;
        }
      }

      if (!observation) break;
      if (investigated) investigationTurns += 1;
      else correctionTurns += 1;
      turnMessages = [
        ...turnMessages,
        { role: "assistant", content: turnText },
        { role: "user", content: observation },
      ];
      callbacks.onToken("\n\n");
      turnText = await runTurn(turnMessages);
    }
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

async function describeImages(
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
    // The vision pass is one-shot; evict it so it does not sit in VRAM
    // alongside the coding model for the rest of the session.
    await unloadOllamaModel(VISION_MODEL);
    return analysis || "Screenshot attached for visual layout reference.";
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new GatewayError("Generation stopped by the user.", "INFERENCE_CANCELLED", 499);
    }
    console.warn("Vision model inspection warning:", error);
    return "Screenshot provided by user for UI/UX visual layout reference.";
  }
}

async function streamFromAnthropic(
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

export async function purgeOllamaMemory(): Promise<void> {
  let unloaded = 0;
  for (const model of [FLASH_MODEL, MAX_MODEL]) {
    if (await unloadOllamaModel(model)) unloaded += 1;
  }
  if (unloaded === 0) throw new GatewayError("No local Frontier model could be unloaded.", "OLLAMA_UNLOAD_FAILED", 503);
}

export const FrontierEngine = {
  streamLocal: streamFromOllama,
  streamAnthropic: streamFromAnthropic,
  describeImages,
  purgeMemory: purgeOllamaMemory,
};
