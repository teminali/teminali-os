/**
 * One question, one JSON object, no tools.
 *
 * The assistant deliberately does **not** go through `AIService.streamMessage`,
 * and the reason is worth stating plainly because the shortcut was tempting:
 * the chat path wraps every turn in a system prompt about emitting workspace
 * files, hands the model a shell executor, and runs completeness and diligence
 * correction passes over the answer. All three are right for a coding turn and
 * all three are wrong here. An operator who asked "where is the archive button"
 * has not asked for a command to be run in their repository, and an assistant
 * invoked by voice is the last place to leave that possibility open.
 *
 * What is kept is the part that matters: which engine answers is still a
 * setting. Frontier, Claude Code and Codex are asked the same question, given
 * no tools they can act with, and held to the same validator afterwards — so
 * changing the engine changes who answers and nothing else.
 */

import { AgentCliService } from "../agentCliService";
import { GatewayClient } from "../gatewayClient";
import type { AssistantEngine, AssistantFrontierMode } from "./types";

/**
 * The rung each CLI is pinned to.
 *
 * Not the operator's chat setting, and never their most permissive one: both
 * of these are being asked a question about a screen, so read-only is the whole
 * requirement. Claude's `manual` mode asks before every tool use, and in
 * headless mode there is nobody to ask — which is exactly the intended answer.
 */
const CLI_PERMISSION: Record<Exclude<AssistantEngine, "frontier">, string> = {
  claude: "manual",
  codex: "read-only",
};

/** Enough for a sentence and a short plan; not enough for an essay. */
const MAX_ANSWER_TOKENS = 500;

/**
 * The context the answer is generated in.
 *
 * An inventory of sixty controls plus a scene description runs to a few
 * thousand tokens, and a window that cannot hold both the question and the
 * answer produces an empty reply with no error — the same silent failure the
 * vision pass hit at 4096. Measured, then written down.
 */
const CONTEXT_TOKENS = 8192;

export interface AskOptions {
  engine: AssistantEngine;
  frontierMode: AssistantFrontierMode;
  signal?: AbortSignal;
}

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

async function askFrontier(prompt: string, mode: AssistantFrontierMode, signal?: AbortSignal): Promise<string> {
  // The router picks the model; the assistant does not hardcode one, so Flash,
  // Auto and Max mean here what they mean everywhere else in the studio.
  const selection = await GatewayClient.resolveModelMode(mode, prompt);
  const response = await GatewayClient.request("/api/ollama/generate", {
    method: "POST",
    signal,
    body: JSON.stringify({
      model: selection.model,
      stream: false,
      keep_alive: "5m",
      options: { num_ctx: CONTEXT_TOKENS, num_predict: MAX_ANSWER_TOKENS, temperature: 0.1 },
      prompt,
    }),
  });
  await GatewayClient.expectOk(response);
  const payload = (await response.json()) as OllamaGenerateResponse;
  if (payload.error) throw new Error(payload.error);
  return payload.response ?? "";
}

async function askAgentCli(
  prompt: string,
  engine: Exclude<AssistantEngine, "frontier">,
  signal?: AbortSignal,
): Promise<string> {
  let text = "";
  await AgentCliService.streamTurn(
    {
      engine,
      prompt,
      // A fresh session every turn. Element ids belong to one look at the
      // screen, so a resumed thread would be reasoning about controls it can no
      // longer name.
      sessionId: null,
      permission: CLI_PERMISSION[engine],
      signal,
    },
    {
      onToken: (token) => {
        text += token;
      },
      onComplete: (data) => {
        // The settled text is authoritative. Claude streams deltas *and* emits
        // the finished message; adding both would double the reply, and a
        // doubled JSON object parses as the first one plus trailing garbage.
        if (data.fullText) text = data.fullText;
      },
    },
  );
  return text;
}

/** Ask the selected engine. Returns its raw reply, unparsed. */
export function askEngine(prompt: string, options: AskOptions): Promise<string> {
  if (options.engine === "frontier") return askFrontier(prompt, options.frontierMode, options.signal);
  return askAgentCli(prompt, options.engine, options.signal);
}

/** Exported so the settings panel can say what each engine is allowed to do. */
export const ASSISTANT_CLI_PERMISSION = CLI_PERMISSION;
