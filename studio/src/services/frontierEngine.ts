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
import { budgetFor, fitHistory } from "./contextBudget";
import { composeSystemPrompt } from "./systemPrompt";
import { CompletenessEngine } from "./completenessEngine";
import { DiligenceEngine } from "./diligenceEngine";
import { parseScreenToolCalls, screenToolCall } from "./screenToolCalls";
import { parseWorkspaceEdits } from "./liveEditProtocol";
import { GatewayClient, GatewayError } from "./gatewayClient";
import { VISION_MODEL } from "./attachmentPolicy";
import {
  buildCommandEvidence,
  closedFenceEnd,
  documentationShellFence,
  hasExecutableCommands,
  runAgentCommands,
  type AgentCommandRequest,
  type CommandExecution,
  type CommandExecutor,
} from "./agentCommands";
import { commandPolicy } from "./preferences.ts";
import {
  buildVideoToolEvidence,
  executeVideoToolRequests,
  hasVideoToolCalls,
  parseFallbackVideoToolCalls,
  parseVideoToolCalls,
  runVideoToolCalls,
  type VideoToolExecutor,
} from "./videoToolCalls";
import {
  buildPlayerToolEvidence,
  executePlayerRequests,
  hasPlayerToolCalls,
  parseFallbackPlayerToolCalls,
  parsePlayerToolCalls,
  type PlayerExecutor,
} from "./playerToolCalls";
import {
  buildAskEvidence,
  executeAskRequests,
  hasAskToolCalls,
  parseAskToolCalls,
  parseFallbackAskToolCalls,
  type AskExecutor,
} from "./askToolCalls";
import type { TurnOrigin } from "./voice/types";
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
  /**
   * The built-in media player, if this host has one on screen.
   *
   * Injected exactly like the editor tools, and for a sharper reason: without
   * it, a model asked to play the file in the viewer reaches for
   * `video-tool` — the only video-shaped tool it has — and reports the
   * timeline's contents as though they were the viewer's. See
   * services/playerToolCalls.ts.
   */
  runPlayer?: PlayerExecutor;
  /** The actions the host's player accepts, for the prompt to advertise. */
  playerActions?: readonly string[];
  /**
   * What the player is showing, as a sentence, read fresh when the prompt is
   * built. A model that can see "paused at 0:01 of 1:44" does not ask the
   * operator which file they meant.
   */
  playerState?: () => string;
  /**
   * Puts a question to the operator and waits for their answer.
   *
   * The only capability here that suspends the turn on a person rather than a
   * machine. Absent, the prompt never advertises the fence and the lane
   * behaves as it did before — the same contract the editor and player blocks
   * keep, because a headless caller has nobody to ask.
   */
  askOperator?: AskExecutor;
  /**
   * Observes the operator's display and returns what is on it.
   *
   * Absent — a headless caller, the arena, a machine without Accessibility —
   * the prompt never advertises the fence and the lane behaves as it did
   * before, the same contract every other block here keeps. Read-only by
   * construction: there is no acting counterpart, because a local model that
   * can click is a different decision from one that can look.
   */
  lookAtScreen?: (question: string) => Promise<string>;
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

import { sanitizeOngoingAssist } from "./voice/speakable";
import { detectCommandThrashing, MAX_THRASH_NOTICES } from "./commandThrashing";
export { sanitizeOngoingAssist };

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
// Player turns are cheaper still — a dispatch to a mounted pane and the
// snapshot it publishes back, with no process spawned and no file read. Six
// covers the longest honest chain (episode -> play -> subtitles -> rate) with
// room for the model to check its work.
const MAX_PLAYER_TURNS = 6;
/**
 * Three questions an exchange, and that is generous.
 *
 * The other budgets bound a machine that might need another look; this one
 * bounds how many times a person is interrupted. A model on its fourth
 * question has stopped working and started interviewing, and the operator's
 * patience is the scarcest thing the lane spends.
 */
const MAX_ASK_TURNS = 3;
// Belt and braces: no combination of the budgets below may loop forever.
const MAX_TOTAL_TURNS = MAX_AGENT_COMMAND_TURNS + MAX_INVESTIGATION_TURNS + MAX_EDITOR_TOOL_TURNS + MAX_PLAYER_TURNS + MAX_ASK_TURNS + 2;
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

/**
 * A content block the gateway's Gemini bridge understands.
 *
 * The bridge speaks the Anthropic Messages shape and translates it — see
 * `server/geminiBridge.js`, which turns an `image` block into the `image_url`
 * data URL Gemini wants. Sending blocks is therefore the whole of what this
 * lane needs to see an attachment; nothing new had to be taught to the server.
 */
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function imageBlock(dataUrl: string): ContentBlock {
  const match = /^data:([^;,]+);base64,/i.exec(dataUrl);
  return {
    type: "image",
    source: {
      type: "base64",
      // A data URL without a declared type is almost always a PNG, and a wrong
      // guess is a rejected block rather than a wrong answer.
      media_type: match ? match[1].toLowerCase() : "image/png",
      data: stripImagePrefix(dataUrl),
    },
  };
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
  origin: TurnOrigin = "text",
): Promise<void> {
  const id = requestId();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let firstTokenAt: number | null = null;
  let accumulated = "";
  let finalChunk: OllamaStreamChunk = {};
  // Fence tags this exchange can actually execute. A turn stops the instant one
  // of them closes, so the model never gets to narrate a result it has not been
  // given. Only tags backed by a real executor qualify: stopping at a fence
  // nothing will run would truncate an answer with no follow-up to complete it.
  const stopTags: string[] = [];
  if (capabilities.runCommand) stopTags.push("frontier-run", "frontier-command");
  if (capabilities.runVideoTool) stopTags.push("video-tool");
  if (capabilities.runPlayer) stopTags.push("player-tool");
  if (capabilities.askOperator) stopTags.push("ask");
  if (capabilities.lookAtScreen) stopTags.push("screen");
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
  // Every limit below is a share of the window this model actually has — the
  // `-8k`/`-32k` its Modelfile pins — not a constant that is generous for one
  // model and fatal for another. See contextBudget.ts for the measurement.
  const budget = budgetFor("frontier", selection.contextTokens);

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

  const isFreshConversation = history.length === 0 || history.every((m) => !m.content || m.role === "system");
  const system = composeSystemPrompt({
    label: selection.label,
    skillInstruction,
    videoTools: capabilities.videoTools,
    player:
      capabilities.runPlayer && capabilities.playerActions && capabilities.playerActions.length > 0
        ? { actions: capabilities.playerActions, showing: capabilities.playerState?.() ?? "" }
        : null,
    origin,
    freshConversation: isFreshConversation,
    canAsk: Boolean(capabilities.askOperator),
    canSeeScreen: Boolean(capabilities.lookAtScreen),
    budgetChars: budget.systemPromptChars,
  });

  /*
    History is fitted newest-first to its own share of the window, and each
    message is capped on its own so one pasted file cannot evict every turn
    around it. A long TypeScript message is pruned to its shape before it is
    cut, which keeps the declarations a model actually needs to refer back to.
  */
  const recent = fitHistory(history.slice(-6), budget, (message, limit) => {
    const pruned = message.content.length > 4_000 ? ASTPrunerService.pruneTypeScript(message.content) : message.content;
    return { ...message, content: pruned.length > limit ? `${pruned.slice(0, limit)}\n…` : pruned };
  });

  const messages = [
    { role: "system", content: system.text },
    ...recent.map((message) => ({ role: message.role, content: message.content })),
    {
      role: "user",
      content: groundedPrompt,
    },
  ];

  // The gateway's audit ingest is metadata-only and allowlisted (see
  // `server/validation.js#validateClientAuditEvent`): an event name from its
  // vocabulary, a provider, and sizes or timings. The model, mode and route
  // reason ride the turn's own `InferenceTelemetry` to `onComplete` instead;
  // sent here they were rejected with 400 on every local turn, and
  // `recordAudit` swallows that.
  await GatewayClient.recordAudit({ event: "prompt", provider: "ollama" });

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
    // Set once a closed executable fence has been seen. Everything the model
    // would say next is about a command that has not run yet, so it is neither
    // streamed to the operator nor kept as part of the turn.
    let cutAtFence = false;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line) as OllamaStreamChunk;
      if (chunk.error) throw new GatewayError(chunk.error, "OLLAMA_ERROR", 502);
      if (chunk.message?.content) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        let text = chunk.message.content;
        if (!cutAtFence && stopTags.length > 0) {
          const alreadyThisTurn = accumulated.length - startedLength;
          const end = closedFenceEnd(accumulated.slice(startedLength) + text, stopTags);
          if (end !== null) {
            text = text.slice(0, Math.max(0, end - alreadyThisTurn));
            cutAtFence = true;
          }
        }
        if (text) {
          accumulated += text;
          callbacks.onToken(text);
        }
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
      for (const line of lines) {
        consume(line);
        if (cutAtFence) break;
      }
      if (cutAtFence) break;
    }
    if (cutAtFence) {
      // Nothing further is wanted from this generation; releasing the reader
      // lets the model stop producing tokens no one will read.
      await reader.cancel().catch(() => {});
    } else {
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
    }
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
    /*
      Player commands get their own budget rather than sharing the editor's.
      A playback exchange is genuinely a chain — episode, then play, then
      subtitles — and spending the timeline's turns on it would leave a model
      that did both with no edits left.
    */
    let playerTurns = 0;
    /** Questions put to the operator this exchange. */
    let askTurns = 0;
    // One look a turn. The display does not change enough between two replies
    // in the same turn to be worth a second screenshot's window.
    let looked = false;
    let correctionTurns = 0;
    let deniedFeedback = 0;
    /** Times this exchange has been told it is retrying its way around a wall. */
    let thrashNotices = 0;
    // Every command run this exchange. The investigation audit needs the whole
    // history, not just the last turn's, to tell "measured then answered" from
    // "measured once, then guessed at the part that mattered".
    const allExecutions: CommandExecution[] = [];

    for (let iteration = 0; iteration < MAX_TOTAL_TURNS; iteration += 1) {
      if (controller.signal.aborted) break;

      let observation = "";
      let investigated = false;

      const thrashing =
        capabilities.runCommand && hasExecutableCommands(turnText) && thrashNotices < MAX_THRASH_NOTICES
          ? detectCommandThrashing(allExecutions, turnText)
          : null;

      if (thrashing) {
        // Held back rather than run: the commands about to go out are the ones
        // that already failed, and letting them fail again buys nothing but a
        // turn off the budget. The model gets the diagnosis in their place.
        thrashNotices += 1;
        investigationTurns += 1;
        observation = thrashing.notice;
        investigated = true;
      } else if (capabilities.runCommand && hasExecutableCommands(turnText) && investigationTurns < MAX_INVESTIGATION_TURNS) {
        const executions = await runAgentCommands(turnText, {
          execute: capabilities.runCommand!,
          signal: controller.signal,
          onToolCall: callbacks.onToolCall,
          approve: approveCommand,
          maxOutputChars: budget.toolResultChars,
          ...commandPolicy(),
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
          maxOutputChars: budget.toolResultChars,
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
      } else if (capabilities.runVideoTool && editorTurns < MAX_EDITOR_TOOL_TURNS) {
        const toolNames = (capabilities.videoTools || []).map((t) => t.name);
        const fallbackRequests = parseFallbackVideoToolCalls(turnText, toolNames);
        if (fallbackRequests.length > 0) {
          const executions = await executeVideoToolRequests(fallbackRequests.slice(0, 6), {
            execute: capabilities.runVideoTool,
            signal: controller.signal,
            onToolCall: callbacks.onToolCall,
            maxOutputChars: budget.toolResultChars,
          });
          if (executions.length > 0) {
            const evidence = buildVideoToolEvidence(executions);
            observation = observation ? `${observation}\n\n${evidence}` : evidence;
            editorTurns += 1;
            investigated = true;
          }
        }
      }

      /*
        The built-in player.

        Cheaper than either sibling: no process is spawned and no file is read.
        The command is handed to whichever pane holds the player and the
        snapshot that comes back is the observation — which is the whole point,
        because a model that is *shown* the player's state after acting stops
        guessing at it. The fallback parse is here for the same reason the
        editor runner has one: a local model that got the protocol right and
        the tag wrong has earned its call.
      */
      if (capabilities.runPlayer && playerTurns < MAX_PLAYER_TURNS) {
        const requests = hasPlayerToolCalls(turnText)
          ? parsePlayerToolCalls(turnText)
          : parseFallbackPlayerToolCalls(turnText);
        if (requests.length > 0) {
          const executions = await executePlayerRequests(requests, {
            execute: capabilities.runPlayer,
            signal: controller.signal,
            onToolCall: callbacks.onToolCall,
          });
          if (executions.length > 0) {
            // Appended, never substituted — the same rule the editor branch
            // keeps. A turn may run a command and press play, and dropping
            // either observation leaves the model repeating the half it was
            // never told the result of.
            const evidence = buildPlayerToolEvidence(executions);
            observation = observation ? `${observation}\n\n${evidence}` : evidence;
            playerTurns += 1;
            investigated = true;
          }
        }
      }

      /*
        The question to the operator.

        Unlike its three siblings this one suspends the turn on a person, so
        it is last: a reply that both ran a command and asked something gets
        the command's real output *and* the answer, and the model reads them
        together. `askTurns` is deliberately tight — a lane that asks three
        times in one exchange is interviewing the operator, not working.

        A dismissed picker still produces an observation. Returning nothing
        would end the exchange in silence, which is the one outcome worse than
        a wrong guess: the operator clicked away and the work stopped without
        a word. `buildAskEvidence` tells the model to pick a default and say
        which, so the turn still lands somewhere.
      */
      if (capabilities.askOperator && askTurns < MAX_ASK_TURNS) {
        const requests = hasAskToolCalls(turnText)
          ? parseAskToolCalls(turnText)
          : parseFallbackAskToolCalls(turnText);
        if (requests.length > 0) {
          const execution = await executeAskRequests(requests, {
            execute: capabilities.askOperator,
            signal: controller.signal,
            onToolCall: callbacks.onToolCall,
          });
          if (execution) {
            const evidence = buildAskEvidence(execution);
            observation = observation ? `${observation}\n\n${evidence}` : evidence;
            askTurns += 1;
            // An answer is evidence the model did not have and could not have
            // measured, so it buys an investigation turn rather than a
            // correction one — the same as a command's output.
            investigated = true;
          }
        }
      }

      /*
        The screen, once a turn.

        A look is an observation like a command's output — evidence the model
        could not have measured — so it buys an investigation turn. One per
        turn and one per reply (`parseScreenToolCalls` keeps only the first):
        a second screenshot is of the same display a moment later, and it costs
        a window that the eval showed is already dropping five sections.

        A look that fails still returns a sentence. Returning nothing would
        leave the model to answer a question about a screen it never saw
        without knowing that it never saw it — which is the invention this
        whole capability exists to remove.
      */
      if (capabilities.lookAtScreen && !looked) {
        const [look] = parseScreenToolCalls(turnText);
        if (look) {
          const call = screenToolCall(look);
          callbacks.onToolCall?.(call);
          let seen: string;
          try {
            seen = await capabilities.lookAtScreen(look.question ?? "");
          } catch (err) {
            seen = `The screen could not be read: ${err instanceof Error ? err.message : String(err)}`;
          }
          callbacks.onToolCall?.({ ...call, status: "completed", result: seen });
          const evidence = `[SCREEN]\n${seen}`;
          observation = observation ? `${observation}\n\n${evidence}` : evidence;
          looked = true;
          investigated = true;
        }
      }

      if (!observation && capabilities.runVideoTool && correctionTurns < MAX_AGENT_COMMAND_TURNS) {
        const videoTools = capabilities.videoTools || [];
        const toolNames = videoTools.map((t) => t.name);

        if (/```video-tool/i.test(turnText) && !hasVideoToolCalls(turnText)) {
          observation =
            "[PROTOCOL ERROR] The ```video-tool fence was incomplete or invalid JSON. " +
            "To call an editor tool, emit a complete ```video-tool fence holding valid JSON, e.g.:\n" +
            "```video-tool\n" +
            '{"tool":"describe_timeline","arguments":{}}\n' +
            "```\n" +
            "Please emit the tool call now.";
          correctionTurns += 1;
        } else if (toolNames.length > 0) {
          const matchingTool = toolNames.find((name) => {
            const inJsonBlock = new RegExp(`["'](?:tool|name)["']\\s*:\\s*["']${name}["']`, "i").test(turnText);
            const announcedIntent = new RegExp(`(?:I'll|I will|calling|let me call|going to call)\\s+${name}`, "i").test(turnText);
            return inJsonBlock || announcedIntent;
          });

          if (matchingTool) {
            observation =
              `[PROTOCOL NOTICE] You indicated calling "${matchingTool}", but did not emit an executable \`\`\`video-tool fence. ` +
              `A \`\`\`json block or plain text is documentation and is never executed.\n` +
              `To execute "${matchingTool}", emit it in an explicit \`\`\`video-tool fence now:\n` +
              "```video-tool\n" +
              `{"tool":"${matchingTool}","arguments":{}}\n` +
              "```";
            correctionTurns += 1;
          }
        }
      }

      if (!observation && qualityCorrections < MAX_QUALITY_CORRECTIONS && correctionTurns < MAX_AGENT_COMMAND_TURNS) {
        const written = parseWorkspaceEdits(turnText, { userPrompt: groundedPrompt })
          .filter((edit) => edit.complete)
          .map((edit) => ({ path: edit.path, content: edit.content }));
        if (written.length > 0) {
          written.forEach((f, fIdx) => {
            callbacks.onToolCall?.({
              id: `patch-${f.path}-${iteration}-${fIdx}`,
              name: "frontier.patch_file",
              arguments: { path: f.path },
              status: "completed",
              result: "Complete implementation written",
            });
          });
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

      // A shell block where a run fence belonged. The model reached for ```bash
      // out of habit, printed the command and told the operator to run it — the
      // turn is over and nothing happened. ```bash stays non-executable, so the
      // repair is to ask for the command again in the fence that does run.
      if (
        !observation &&
        capabilities.runCommand &&
        !hasExecutableCommands(turnText) &&
        correctionTurns < MAX_AGENT_COMMAND_TURNS
      ) {
        const shellBlock = documentationShellFence(turnText);
        if (shellBlock) {
          callbacks.onToolCall?.({
            id: `tool-protocol-${id}-${iteration}`,
            name: "frontier.correct_protocol",
            arguments: { fence: "bash" },
            status: "completed",
            result: "A shell block was printed instead of an executable fence.",
          });
          observation =
            "[PROTOCOL NOTICE] You printed that command in a ```bash block, which is " +
            "documentation and is never executed, and then asked the operator to run it. " +
            "You have the shell.\n" +
            "If you meant to run it, emit it now in a ```frontier-run fence and stop there — " +
            "the real output comes back to you before you answer again:\n" +
            "```frontier-run\n" +
            `${shellBlock}\n` +
            "```\n" +
            "If that block was only an example for the operator to keep, say so plainly and do not repeat it.";
          correctionTurns += 1;
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
    contextBudget: {
      windowTokens: budget.windowTokens,
      systemPromptChars: system.chars,
      dropped: system.dropped,
    },
  };
  await GatewayClient.recordAudit({
    event: "model_call",
    provider: "ollama",
    status: 200,
    durationMs: telemetry.totalDurationMs,
  });
  const deliveredText = !isFreshConversation ? sanitizeOngoingAssist(accumulated) : accumulated;
  callbacks.onComplete({
    fullText: deliveredText,
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
  await GatewayClient.recordAudit({
    event: "model_call",
    provider: "anthropic",
    status: 200,
    durationMs: telemetry.totalDurationMs,
  });
  const isFreshConversation = history.length === 0 || history.every((m) => !m.content || m.role === "system");
  const deliveredText = !isFreshConversation ? sanitizeOngoingAssist(accumulated) : accumulated;
  callbacks.onComplete({
    fullText: deliveredText,
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

async function streamFromGemini(
  userPrompt: string,
  history: ChatMessage[],
  callbacks: StreamCallbacks,
  options: {
    mode?: "max" | "gemini";
    signal?: AbortSignal;
    model?: string;
    origin?: TurnOrigin;
    /** Attached images as base64 data URLs; sent as Anthropic image blocks. */
    images?: string[];
    onWorkspace?: (event: any) => void;
    workingDirectory?: string;
    capabilities?: EngineCapabilities;
    approveCommand?: (request: AgentCommandRequest) => Promise<boolean>;
    workspaceProjects?: {
      current?: { name: string; path: string; kind?: string };
      recent?: Array<{ name: string; path: string; kind?: string }>;
    };
  } = {},
): Promise<void> {
  const id = requestId();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let firstTokenAt: number | null = null;
  let accumulated = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const isVoice = options.origin === "voice";
  const modelToUse = options.model || (isVoice ? "gemini-2.5-flash" : "gemini-3.8-flash");

  // Use injected workspace state to ground the model
  const projects = options.workspaceProjects;
  const currentPath = projects?.current?.path || options.workingDirectory || "Not set";
  const currentName = projects?.current?.name || currentPath.split("/").filter(Boolean).pop() || "Workspace";
  const recentList = (projects?.recent || [])
    .map((p) => `- ${p.name} (${p.path}) [${p.kind || "code"}]`)
    .join("\n");

  const commandInstructions = options.capabilities?.runCommand
    ? `\n\nCommand Execution Rules:
You have live, direct terminal and filesystem access inside Teminali OS via \`\`\`frontier-run code fences.
When the operator asks a question or gives an instruction that requires inspecting files, checking folder sizes, disk space, listing files, running tests, or measuring system state (e.g. "tell me the total size of all the files on my desktop folder"):
1. NEVER say "I cannot run commands", "I lack terminal execution access", or tell the user to run commands themselves.
2. Emit the exact command immediately in a \`\`\`frontier-run fence:
\`\`\`frontier-run
<command>
\`\`\`
3. The system executes the command automatically and returns the real command output in an observation turn before you deliver your spoken response.
4. After receiving the output, synthesize and state the answer directly in natural spoken dialogue without code fences.`
    : "";

  const system = isVoice
    ? `Your name is Temy, the real-time voice assistant inside Teminali OS. You are speaking directly with the operator.

Spoken Dialogue Rules:
1. Speak naturally, clearly, and concisely (1 to 3 short sentences).
2. NEVER use markdown formatting in spoken dialogue (no asterisks **, no headers #, no bullet points -).
3. Do not output raw URLs or large blocks of code; summarize clearly instead.
4. When the user asks to switch workspace, change project, open a folder, or open a file, emit:
   <workspace-action action="open-project" path="<absolute-path>" />
   <workspace-action action="open-folder" path="<path>" />
   <workspace-action action="open-file" path="<path>" />
   <workspace-action action="reveal" path="<path>" />
   followed by a friendly, 1-sentence spoken confirmation explaining what was done.
5. Answer immediately without filler greetings or preamble unless greeted.
${commandInstructions}

Current Workspace: ${currentName} (${currentPath})
Recent Workspaces:
${recentList || "None"}`
    : `Your name is Temy, the assistant inside Teminali Code. If asked who or what you are, you are Temy. Be concise, direct, helpful, and never claim commands ran without evidence.
${commandInstructions}

Current Workspace: ${currentName} (${currentPath})
Recent Workspaces:
${recentList || "None"}

You have the ability to switch workspaces and open folders/files in Teminali Code!
When the user asks to switch workspace, change project, open a folder, or open a file:
- Match the user's intent to the corresponding workspace from Recent Workspaces (even if speech-to-text slightly misrecognized or colloquial, e.g. "D4K Video Unloader Plus" refers to "4K Video Downloader+").
- To switch workspace or open a project, emit:
  <workspace-action action="open-project" path="<absolute-path>" />
- To open a folder as a gallery, emit:
  <workspace-action action="open-folder" path="<path>" />
- To open a file in an editor tab, emit:
  <workspace-action action="open-file" path="<path>" />
- To reveal a file/folder in the sidebar, emit:
  <workspace-action action="reveal" path="<path>" />
Always include a natural, friendly confirmation message explaining what you did.`;

  const attachedImages = options.images ?? [];
  const messages: Array<{ role: "assistant" | "user"; content: string | ContentBlock[] }> = [
    ...history.filter((message) => message.role !== "system").slice(-8).map((message) => ({
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: message.content,
    })),
    // Blocks only when there is something to put in them: a plain string is
    // what every other turn sends, and the bridge unwraps a lone text block
    // back to one anyway.
    attachedImages.length > 0
      ? {
          role: "user" as const,
          content: [
            { type: "text" as const, text: userPrompt || "Look at the attached image(s)." },
            ...attachedImages.map(imageBlock),
          ],
        }
      : { role: "user" as const, content: userPrompt },
  ];

  const MAX_AGENT_TURNS = 5;

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    if (options.signal?.aborted) break;

    const response = await GatewayClient.request("/api/gemini/v1/messages", {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify({
        model: modelToUse,
        max_tokens: 4096,
        stream: true,
        system,
        messages,
      }),
    });
    await GatewayClient.expectOk(response);
    if (!response.body) throw new GatewayError("Gemini returned no response stream.", "EMPTY_STREAM", 502);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let turnText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const event of events) {
          const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          let data: any;
          try {
            data = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          if (data.error?.message) throw new GatewayError(data.error.message, "GEMINI_ERROR", 502);
          if (data.message?.usage?.input_tokens) totalInputTokens = data.message.usage.input_tokens;
          if (data.usage?.output_tokens) totalOutputTokens += data.usage.output_tokens;
          if (data.delta?.text) {
            if (firstTokenAt === null) firstTokenAt = performance.now();
            turnText += data.delta.text;
            accumulated += data.delta.text;
            callbacks.onToken(data.delta.text);
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    if (!turnText.trim() && turn === 0) {
      throw new GatewayError("Gemini completed without model output.", "EMPTY_MODEL_OUTPUT", 502);
    }

    // Check if turnText contains executable commands
    if (options.capabilities?.runCommand && hasExecutableCommands(turnText)) {
      const executions = await runAgentCommands(turnText, {
        execute: options.capabilities.runCommand,
        signal: options.signal,
        onToolCall: callbacks.onToolCall,
        approve: options.approveCommand,
        maxOutputChars: 4000,
        ...commandPolicy(),
      });
      const observation = buildCommandEvidence(executions);
      messages.push({ role: "assistant", content: turnText });
      messages.push({ role: "user", content: observation });
      callbacks.onToken("\n\n");
      accumulated += "\n\n";
      // Continue next turn so Gemini can answer based on command evidence
      continue;
    }

    // No commands to run, turn complete
    break;
  }

  // Execute any workspace action emitted by the model
  const actionMatch = accumulated.match(/<workspace-action\s+action=["']([^"']+)["']\s+path=["']([^"']+)["']\s*\/?>/i);
  if (actionMatch) {
    const [, action, targetPath] = actionMatch;
    if (action === "open-project") {
      const match = projects?.recent?.find(
        (p) => p.path === targetPath || p.name.toLowerCase() === targetPath.toLowerCase(),
      ) || { path: targetPath, name: targetPath.split("/").filter(Boolean).pop() || targetPath, kind: "code" };
      options.onWorkspace?.({
        type: "workspace",
        action: "open-project",
        path: match.path,
        name: match.name,
        kind: (match.kind as any) || "code",
      });
    } else if (action === "open-folder") {
      options.onWorkspace?.({ type: "workspace", action: "open-folder", path: targetPath });
    } else if (action === "open-file") {
      options.onWorkspace?.({ type: "workspace", action: "open-file", path: targetPath });
    } else if (action === "reveal") {
      options.onWorkspace?.({ type: "workspace", action: "reveal", path: targetPath });
    }
  }

  const totalDurationMs = performance.now() - started;
  const isMax = options.mode === "max";
  const engineUsed = isVoice ? "Gemini Voice Assistant" : isMax ? "Frontier Max (Gemini)" : "Gemini Flash";
  callbacks.onComplete({
    fullText: accumulated,
    costUsd: 0.0005,
    costLabel: isMax ? "Included" : "Free (BYOK)",
    tokensCount: totalInputTokens + totalOutputTokens,
    durationSec: Number((totalDurationMs / 1000).toFixed(2)),
    engineUsed,
    mode: isMax ? "max" : "gemini",
    routeReason: isVoice ? "voice_assistant_gemini" : isMax ? "frontier_max_gemini" : "gemini_flash_byok",
    telemetry: {
      requestId: id,
      model: modelToUse,
      startedAt,
      completedAt: new Date().toISOString(),
      totalDurationMs: Number(totalDurationMs.toFixed(2)),
      loadDurationMs: 0,
      timeToFirstTokenMs: firstTokenAt === null ? null : Number((firstTokenAt - started).toFixed(2)),
      promptTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      promptTokensPerSec: null,
      outputTokensPerSec: totalOutputTokens > 0 ? Number((totalOutputTokens / (totalDurationMs / 1000)).toFixed(2)) : null,
      source: "anthropic",
    },
  });
}

export async function purgeOllamaMemory(): Promise<void> {
  let unloaded = 0;
  for (const model of [FLASH_MODEL, MAX_MODEL]) {
    if (await unloadOllamaModel(model)) unloaded += 1;
  }
  if (unloaded === 0) throw new GatewayError("No local Frontier model could be unloaded.", "OLLAMA_UNLOAD_FAILED", 503);
}

export interface DigestStreamOptions {
  signal: AbortSignal;
  /** `num_predict` — the digest is two short sentences; see `spokenDigest.ts`. */
  maxTokens: number;
  onToken: (token: string) => void;
}

/**
 * The spoken digest's own lane. The digest prompt alone — no agent system
 * prompt, no history, no tool loop — on the Flash model, with the context
 * size the reply lane resolved so Ollama reuses the runner it already has (a
 * `num_ctx` change was measured at 1.5–2.4 s of reload). Tokens reach
 * `onToken` as they arrive. Aborting stops the generation and leaves the model
 * resident: `streamFromOllama` unloads on abort, and a digest that gave up on
 * time must not make the next one start from a cold load (17 s measured).
 */
async function streamFlashDigest(prompt: string, options: DigestStreamOptions): Promise<void> {
  const selection = await GatewayClient.resolveModelMode("flash", "");
  const response = await GatewayClient.request("/api/ollama/chat", {
    method: "POST",
    signal: options.signal,
    body: JSON.stringify({
      model: selection.model,
      keep_alive: "30m",
      stream: true,
      options: { num_ctx: selection.contextTokens, num_batch: 128, temperature: 0.15, num_predict: options.maxTokens },
      messages: [{ role: "user", content: prompt }],
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
    if (chunk.message?.content) options.onToken(chunk.message.content);
  };
  try {
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
  } finally {
    // Releasing the reader lets Ollama stop producing tokens no one will read.
    await reader.cancel().catch(() => {});
  }
}

export const FrontierEngine = {
  streamLocal: streamFromOllama,
  streamAnthropic: streamFromAnthropic,
  streamGemini: streamFromGemini,
  streamDigest: streamFlashDigest,
  describeImages,
  purgeMemory: purgeOllamaMemory,
};
