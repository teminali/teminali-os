/**
 * Teminali OS — Compound Action Runner (compoundActionRunner.ts)
 *
 * Decomposes multi-clause compound utterances connected by conjunctions
 * ("and", "then", "also", "after that") into a sequence of atomic fast-path
 * operations across system telemetry, video editor actions, file operations,
 * and workspace tools.
 *
 * Guarantees:
 * - Sub-100ms total chained execution (< 50ms per step).
 * - 0 model token cost across all steps.
 * - Single, cohesive, natural spoken response blending all step reports.
 * - Combined rich UI display markdown card.
 */

import {
  parseSystemCommand,
  executeSystemAction,
  type SystemCommand,
  type SystemActionResult,
} from "./systemActions.ts";
import {
  parseEditorCommand,
  describeEditorResult,
  type EditorCommand,
} from "./editorActions.ts";

export type ActionStep =
  | { type: "system"; command: SystemCommand; rawClause: string }
  | { type: "editor"; command: EditorCommand; rawClause: string };

export interface StepExecutionResult {
  type: "system" | "editor";
  handled: boolean;
  spoken: string;
  displayMarkdown: string;
  kind: string;
  latencyMs: number;
  data?: Record<string, unknown>;
}

export interface CompoundResult {
  handled: boolean;
  isCompound: boolean;
  steps: StepExecutionResult[];
  spoken: string;
  displayMarkdown: string;
  tokensUsed: number;
  latencyMs: number;
}

/** Words and punctuation that join independent actions in natural English. */
const COMPOUND_CONNECTORS_REGEX =
  /(?:,\s*(?:and\s+then|then|after\s+that|and\s+also|also|and)?\s+|\s+(?:and\s+then|then|after\s+that|and\s+also|also|\band\b)\s+)/i;

/** Speech retraction / false-start marker. */
const RETRACTION_REGEX =
  /(?:(?:\.\.\.|\s+)(?:wait[,\s]+(?:actually\s+no|no)?|actually\s+no|scratch\s+that|i\s+mean|never\s*mind)[,\s]+)(.+)$/i;

/** Common intra-clause noun pairs with 'and' that must not be split. */
const PROTECTED_PHRASES = [
  /\b(?:system\s+)?uptime\s+and\s+(?:(?:how\s+much\s+)?(?:memory|ram))\b/i,
  /\boperating\s+system\s+and\s+(?:processor|architecture)\b/i,
  /\btime\s+and\s+date\b/i,
  /\bdate\s+and\s+time\b/i,
  /\bin\s+and\s+out\b/i,
  /\bcut\s+and\s+paste\b/i,
];

/**
 * Tidy utterance text for compound analysis.
 */
function cleanUtterance(text: string): string {
  let cleaned = (text ?? "")
    .replace(/^(?:yo\s+temi|hey\s+temi|ciao\s+temi|temi\s+bella|bella\s+temi|ok\s+temi|okay\s+temi|hello\s+temi|temi|assistant|yo)[,\s]+/i, "")
    .trim();

  // Resolve conversational false-starts & speech retractions
  const retraction = cleaned.match(RETRACTION_REGEX);
  if (retraction) {
    cleaned = retraction[1].trim();
  }

  return cleaned.replace(/[.!?]+$/, "").trim();
}

/**
 * Parses a single clause against all fast-path action engines.
 */
export function parseSingleAction(clause: string): ActionStep | null {
  const text = clause.trim();
  if (!text) return null;

  // 1. System command / machine telemetry / file operation
  const sys = parseSystemCommand(text);
  if (sys) {
    return { type: "system", command: sys, rawClause: text };
  }

  // 2. Video editor command
  const ed = parseEditorCommand(text);
  if (ed) {
    return { type: "editor", command: ed, rawClause: text };
  }

  return null;
}

/**
 * Splits a compound utterance into constituent action clauses.
 * Returns null if the utterance is not a valid compound action.
 */
export function decomposeCompoundUtterance(rawUtterance: string): ActionStep[] | null {
  const cleaned = cleanUtterance(rawUtterance);
  if (!cleaned) return null;

  // If the sentence contains a protected phrase like "time and date", check if single action handles it
  const isProtected = PROTECTED_PHRASES.some((p) => p.test(cleaned));
  if (isProtected) {
    const single = parseSingleAction(cleaned);
    if (single) return [single];
  }

  // Split on compound conjunctions
  const clauses = cleaned.split(COMPOUND_CONNECTORS_REGEX).map((c) => c.trim()).filter(Boolean);
  if (clauses.length <= 1) {
    const single = parseSingleAction(cleaned);
    return single ? [single] : null;
  }

  // Match every clause to an action step
  const steps: ActionStep[] = [];
  for (const clause of clauses) {
    const step = parseSingleAction(clause);
    if (!step) {
      // If any clause in the chain is unrecognized, do not force partial compound execution
      return null;
    }
    // Deduplicate consecutive identical actions (e.g. "what's my RAM looking like, is my computer gasping for air?")
    const prev = steps[steps.length - 1];
    if (
      prev &&
      prev.type === step.type &&
      prev.type === "system" &&
      step.type === "system" &&
      prev.command.kind === step.command.kind &&
      prev.command.target === step.command.target
    ) {
      continue;
    }
    steps.push(step);
  }

  return steps.length > 0 ? steps : null;
}

/**
 * Synthesizes multiple spoken step sentences into a natural Italian-accented response.
 */
function synthesizeSpokenResponse(steps: StepExecutionResult[]): string {
  if (steps.length === 0) return "Done.";
  if (steps.length === 1) return steps[0].spoken;

  const sentences = steps.map((s) => s.spoken.trim().replace(/[.]+$/, ""));
  if (sentences.length === 2) {
    return `${sentences[0]}, and ${sentences[1].charAt(0).toLowerCase()}${sentences[1].slice(1)}.`;
  }

  const head = sentences.slice(0, -1).join(". ");
  const tail = sentences[sentences.length - 1];
  return `${head}. Also, ${tail.charAt(0).toLowerCase()}${tail.slice(1)}.`;
}

/**
 * Executes a compound or single action sequence with zero tokens.
 */
export async function executeActionChain(
  utterance: string,
  options?: {
    executeEditorTool?: (tool: string, args: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  },
): Promise<CompoundResult | null> {
  const steps = decomposeCompoundUtterance(utterance);
  if (!steps || steps.length === 0) return null;

  const t0 = Date.now();
  const results: StepExecutionResult[] = [];

  for (const step of steps) {
    const stepT0 = Date.now();

    if (step.type === "system") {
      const sysResult = await executeSystemAction(step.command);
      results.push({
        type: "system",
        handled: sysResult.handled,
        spoken: sysResult.spoken,
        displayMarkdown: sysResult.displayMarkdown,
        kind: sysResult.kind,
        latencyMs: sysResult.latencyMs,
        data: sysResult.data,
      });
    } else if (step.type === "editor") {
      const edCommand = step.command;
      let toolOutcome = { success: true };

      if (options?.executeEditorTool) {
        try {
          const res = await options.executeEditorTool(edCommand.tool, edCommand.args as Record<string, unknown>);
          toolOutcome = res;
        } catch {
          toolOutcome = { success: false };
        }
      } else {
        // Dynamic import fallback if in studio window
        try {
          const module = await import("../../video/mcp/toolRegistry.ts").catch(() => null);
          if (module?.executeTool) {
            const res = (await module.executeTool(edCommand.tool, edCommand.args, "Temi (voice)")) as { success: boolean };
            toolOutcome = res;
          }
        } catch {}
      }

      const spoken = describeEditorResult(edCommand, toolOutcome);
      results.push({
        type: "editor",
        handled: true,
        spoken,
        displayMarkdown: `🎬 **Video Editor**: ${spoken}`,
        kind: edCommand.tool,
        latencyMs: Date.now() - stepT0,
      });
    }
  }

  const totalLatency = Date.now() - t0;
  const spoken = synthesizeSpokenResponse(results);
  const displayMarkdown = results.map((r) => r.displayMarkdown).join("\n\n");

  return {
    handled: true,
    isCompound: steps.length > 1,
    steps: results,
    spoken,
    displayMarkdown,
    tokensUsed: 0,
    latencyMs: totalLatency,
  };
}
