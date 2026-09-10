/**
 * Gemini Bridge for Claude Code — translates Anthropic Messages API to Google Gemini.
 *
 * Claude Code natively speaks the Anthropic Messages API (/v1/messages).
 * This bridge accepts Anthropic-formatted requests from Claude Code, translates
 * them to Google AI Studio's OpenAI-compatible completions API (or Gemini API),
 * and streams back the exact Server-Sent Events (SSE) Claude Code requires:
 *   message_start -> content_block_start -> content_block_delta -> content_block_stop -> message_delta -> message_stop
 *
 * Zero external daemons required. Runs directly in the Teminali OS local gateway.
 */

import { randomUUID } from "node:crypto";

export const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/**
 * Normalizes an incoming model identifier to a supported Gemini model name.
 */
export function normalizeGeminiModel(model) {
  if (!model || typeof model !== "string") return DEFAULT_GEMINI_MODEL;
  const trimmed = model.trim().toLowerCase();
  if (trimmed.includes("3.8-flash") || trimmed.includes("3.8")) return "gemini-3.8-flash";
  if (trimmed.includes("3.6-flash") || trimmed.includes("3.6")) return "gemini-3.6-flash";
  if (trimmed.includes("2.5-flash")) return "gemini-2.5-flash";
  if (trimmed.includes("2.0-flash")) return "gemini-2.0-flash";
  if (trimmed.includes("2.5-pro") || trimmed.includes("pro")) return "gemini-2.5-pro";
  if (trimmed.includes("1.5-pro")) return "gemini-2.5-pro";
  if (trimmed.startsWith("gemini-")) return model.trim();
  return DEFAULT_GEMINI_MODEL;
}

// Cache of Gemini thought signatures indexed by tool call ID and tool name
// This prevents 400 "Function call is missing a thought_signature" errors on subsequent turns.
const thoughtSignatureCache = new Map();

export function recordThoughtSignature(callId, signature, toolName = null) {
  if (!signature) return;
  if (callId) thoughtSignatureCache.set(callId, signature);
  if (toolName) thoughtSignatureCache.set(`tool:${toolName}`, signature);
  // Cap cache size at 1000 items
  if (thoughtSignatureCache.size > 1000) {
    const firstKey = thoughtSignatureCache.keys().next().value;
    if (firstKey) thoughtSignatureCache.delete(firstKey);
  }
}

export function lookupThoughtSignature(callId, toolName = null) {
  if (callId && thoughtSignatureCache.has(callId)) {
    return thoughtSignatureCache.get(callId);
  }
  if (toolName && thoughtSignatureCache.has(`tool:${toolName}`)) {
    return thoughtSignatureCache.get(`tool:${toolName}`);
  }
  return null;
}

/**
 * Translates an Anthropic /v1/messages request body into an OpenAI-compatible request body
 * suitable for Google AI Studio's /chat/completions endpoint.
 */
export function translateAnthropicToOpenAI(anthropicBody) {
  const model = normalizeGeminiModel(anthropicBody.model);
  const messages = [];

  // System prompt
  if (anthropicBody.system) {
    let systemText = "";
    if (typeof anthropicBody.system === "string") {
      systemText = anthropicBody.system;
    } else if (Array.isArray(anthropicBody.system)) {
      systemText = anthropicBody.system
        .map((part) => (typeof part === "string" ? part : part.text || ""))
        .join("\n\n");
    }
    if (systemText.trim()) {
      messages.push({ role: "system", content: systemText.trim() });
    }
  }

  // Conversation turns
  const incomingMessages = Array.isArray(anthropicBody.messages) ? anthropicBody.messages : [];
  for (const msg of incomingMessages) {
    const role = msg.role === "assistant" ? "assistant" : "user";

    if (typeof msg.content === "string") {
      messages.push({ role, content: msg.content });
      continue;
    }

    if (Array.isArray(msg.content)) {
      if (role === "assistant") {
        let textContent = "";
        const toolCalls = [];

        for (const item of msg.content) {
          if (item.type === "text") {
            textContent += (textContent ? "\n" : "") + (item.text || "");
          } else if (item.type === "tool_use") {
            const callId = item.id || `call_${randomUUID().slice(0, 8)}`;
            const toolCallObj = {
              id: callId,
              type: "function",
              function: {
                name: item.name,
                arguments: typeof item.input === "string" ? item.input : JSON.stringify(item.input || {}),
              },
            };

            const sig = lookupThoughtSignature(item.id, item.name);
            if (sig) {
              toolCallObj.extra_content = {
                google: {
                  thought_signature: sig,
                },
              };
            }

            toolCalls.push(toolCallObj);
          }
        }

        const assistantMsg = { role: "assistant" };
        if (textContent) assistantMsg.content = textContent;
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        messages.push(assistantMsg);
      } else {
        // User turn: could contain text, images, or tool_result
        const contentParts = [];
        const toolResults = [];

        for (const item of msg.content) {
          if (item.type === "text") {
            contentParts.push({ type: "text", text: item.text || "" });
          } else if (item.type === "image" && item.source) {
            const mediaType = item.source.media_type || "image/png";
            const base64Data = item.source.data || "";
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${mediaType};base64,${base64Data}` },
            });
          } else if (item.type === "tool_result") {
            let resultText = "";
            if (typeof item.content === "string") {
              resultText = item.content;
            } else if (Array.isArray(item.content)) {
              resultText = item.content.map((c) => c.text || JSON.stringify(c)).join("\n");
            } else if (item.content) {
              resultText = JSON.stringify(item.content);
            }
            toolResults.push({
              role: "tool",
              tool_call_id: item.tool_use_id,
              content: resultText,
            });
          }
        }

        // If user sent tool results, those must be emitted as role: "tool"
        for (const tr of toolResults) {
          messages.push(tr);
        }

        if (contentParts.length === 1 && contentParts[0].type === "text") {
          messages.push({ role: "user", content: contentParts[0].text });
        } else if (contentParts.length > 0) {
          messages.push({ role: "user", content: contentParts });
        }
      }
    }
  }

  // Tools
  let tools = undefined;
  if (Array.isArray(anthropicBody.tools) && anthropicBody.tools.length > 0) {
    tools = anthropicBody.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
  }

  const payload = {
    model,
    messages,
    stream: Boolean(anthropicBody.stream),
  };

  if (tools) payload.tools = tools;
  if (typeof anthropicBody.max_tokens === "number") {
    payload.max_tokens = anthropicBody.max_tokens;
  }
  if (typeof anthropicBody.temperature === "number") {
    payload.temperature = anthropicBody.temperature;
  }

  return payload;
}

/**
 * Pipes an OpenAI-compatible SSE stream from Google AI Studio and translates it
 * into Anthropic Messages SSE events for Claude Code.
 */
export async function streamOpenAIToAnthropic(openaiResponse, res, options = {}) {
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const model = options.model || DEFAULT_GEMINI_MODEL;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const sendEvent = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 1. Initial message_start
  sendEvent("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });

  let currentBlockIndex = -1;
  let currentBlockType = null; // "text" | "tool_use"
  let currentToolId = null;
  let totalOutputTokens = 0;
  let finishReason = null;

  const closeCurrentBlock = () => {
    if (currentBlockType !== null && currentBlockIndex >= 0) {
      sendEvent("content_block_stop", {
        type: "content_block_stop",
        index: currentBlockIndex,
      });
      currentBlockType = null;
    }
  };

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of openaiResponse.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        continue;
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (!delta) continue;

      // Handle Text Content
      if (delta.content) {
        if (currentBlockType !== "text") {
          closeCurrentBlock();
          currentBlockIndex += 1;
          currentBlockType = "text";
          sendEvent("content_block_start", {
            type: "content_block_start",
            index: currentBlockIndex,
            content_block: { type: "text", text: "" },
          });
        }

        totalOutputTokens += Math.max(1, Math.ceil(delta.content.length / 4));
        sendEvent("content_block_delta", {
          type: "content_block_delta",
          index: currentBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      // Handle Tool Calls
      if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const fn = tc.function;
          const signature = tc.extra_content?.google?.thought_signature || tc.thought_signature;
          if (tc.id || fn?.name) {
            // New tool call starting
            closeCurrentBlock();
            currentBlockIndex += 1;
            currentBlockType = "tool_use";
            currentToolId = tc.id || `call_${randomUUID().slice(0, 10)}`;

            if (signature) {
              recordThoughtSignature(currentToolId, signature, fn?.name);
            }

            sendEvent("content_block_start", {
              type: "content_block_start",
              index: currentBlockIndex,
              content_block: {
                type: "tool_use",
                id: currentToolId,
                name: fn?.name || "tool",
                input: {},
              },
            });
          } else if (signature && currentToolId) {
            recordThoughtSignature(currentToolId, signature);
          }

          if (fn?.arguments && currentBlockType === "tool_use") {
            totalOutputTokens += Math.max(1, Math.ceil(fn.arguments.length / 4));
            sendEvent("content_block_delta", {
              type: "content_block_delta",
              index: currentBlockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: fn.arguments,
              },
            });
          }
        }
      }
    }
  }

  // Close any remaining active block
  closeCurrentBlock();

  // Final message_delta and message_stop
  const stopReason = finishReason === "tool_calls" ? "tool_use" : "end_turn";
  sendEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: Math.max(1, totalOutputTokens) },
  });

  sendEvent("message_stop", { type: "message_stop" });
  res.end();
}

/**
 * Handles non-streaming responses from Google AI Studio and formats as Anthropic response JSON.
 */
export function formatAnthropicJsonResponse(openaiJson, model = DEFAULT_GEMINI_MODEL) {
  const choice = openaiJson.choices?.[0];
  const message = choice?.message || {};
  const content = [];

  if (message.content) {
    content.push({ type: "text", text: message.content });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      const callId = tc.id || `call_${randomUUID().slice(0, 8)}`;
      const signature = tc.extra_content?.google?.thought_signature || tc.thought_signature;
      if (signature) {
        recordThoughtSignature(callId, signature, tc.function?.name);
      }
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        input = { raw: tc.function?.arguments || "" };
      }
      content.push({
        type: "tool_use",
        id: callId,
        name: tc.function?.name || "tool",
        input,
      });
    }
  }

  const stopReason = choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
  const promptTokens = openaiJson.usage?.prompt_tokens || 100;
  const completionTokens = openaiJson.usage?.completion_tokens || 20;

  return {
    id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
    },
  };
}
