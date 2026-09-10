import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  DEFAULT_GEMINI_MODEL,
  formatAnthropicJsonResponse,
  normalizeGeminiModel,
  streamOpenAIToAnthropic,
  translateAnthropicToOpenAI,
} from "../server/geminiBridge.js";

describe("geminiBridge", () => {
  describe("normalizeGeminiModel", () => {
    it("normalizes known models and aliases", () => {
      assert.equal(normalizeGeminiModel(null), DEFAULT_GEMINI_MODEL);
      assert.equal(normalizeGeminiModel(""), DEFAULT_GEMINI_MODEL);
      assert.equal(normalizeGeminiModel("gemini-3.8-flash"), "gemini-3.8-flash");
      assert.equal(normalizeGeminiModel("gemini-2.5-flash"), "gemini-2.5-flash");
      assert.equal(normalizeGeminiModel("gemini-pro"), "gemini-2.5-pro");
      assert.equal(normalizeGeminiModel("gemini-2.0-flash"), "gemini-2.0-flash");
      assert.equal(normalizeGeminiModel("claude-opus"), DEFAULT_GEMINI_MODEL);
    });
  });

  describe("translateAnthropicToOpenAI", () => {
    it("translates basic system prompt and user text", () => {
      const anthropic = {
        model: "gemini-2.5-flash",
        system: "You are Temy.",
        messages: [{ role: "user", content: "Hello world" }],
        stream: true,
        max_tokens: 1024,
      };

      const result = translateAnthropicToOpenAI(anthropic);
      assert.equal(result.model, "gemini-2.5-flash");
      assert.equal(result.stream, true);
      assert.equal(result.max_tokens, 1024);
      assert.equal(result.messages.length, 2);
      assert.deepEqual(result.messages[0], { role: "system", content: "You are Temy." });
      assert.deepEqual(result.messages[1], { role: "user", content: "Hello world" });
    });

    it("translates tools and function schemas", () => {
      const anthropic = {
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "List files" }],
        tools: [
          {
            name: "Bash",
            description: "Run shell command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      };

      const result = translateAnthropicToOpenAI(anthropic);
      assert.equal(result.tools?.length, 1);
      assert.equal(result.tools[0].type, "function");
      assert.equal(result.tools[0].function.name, "Bash");
      assert.deepEqual(result.tools[0].function.parameters.required, ["command"]);
    });

    it("translates assistant tool calls and user tool results", () => {
      const anthropic = {
        model: "gemini-2.5-flash",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Checking directory" },
              { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_01", content: "file1.txt\nfile2.txt" },
            ],
          },
        ],
      };

      const result = translateAnthropicToOpenAI(anthropic);
      assert.equal(result.messages.length, 2);

      const assistantMsg = result.messages[0];
      assert.equal(assistantMsg.role, "assistant");
      assert.equal(assistantMsg.content, "Checking directory");
      assert.equal(assistantMsg.tool_calls.length, 1);
      assert.equal(assistantMsg.tool_calls[0].id, "toolu_01");
      assert.equal(assistantMsg.tool_calls[0].function.name, "Bash");
      assert.equal(assistantMsg.tool_calls[0].function.arguments, '{"command":"ls"}');

      const toolMsg = result.messages[1];
      assert.equal(toolMsg.role, "tool");
      assert.equal(toolMsg.tool_call_id, "toolu_01");
      assert.equal(toolMsg.content, "file1.txt\nfile2.txt");
    });
  });

  describe("formatAnthropicJsonResponse", () => {
    it("formats non-streaming JSON response with text and tool calls", () => {
      const openai = {
        choices: [
          {
            message: {
              content: "I will read the file.",
              tool_calls: [
                {
                  id: "call_99",
                  type: "function",
                  function: { name: "Read", arguments: '{"path":"README.md"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 15 },
      };

      const res = formatAnthropicJsonResponse(openai, "gemini-2.5-flash");
      assert.equal(res.type, "message");
      assert.equal(res.role, "assistant");
      assert.equal(res.stop_reason, "tool_use");
      assert.equal(res.content.length, 2);
      assert.equal(res.content[0].type, "text");
      assert.equal(res.content[0].text, "I will read the file.");
      assert.equal(res.content[1].type, "tool_use");
      assert.equal(res.content[1].name, "Read");
      assert.deepEqual(res.content[1].input, { path: "README.md" });
      assert.equal(res.usage.input_tokens, 50);
      assert.equal(res.usage.output_tokens, 15);
    });
  });

  describe("streamOpenAIToAnthropic", () => {
    it("streams text and tool calls in Anthropic SSE format", async () => {
      const chunks = [
        `data: {"choices":[{"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n`,
        `data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"Bash","arguments":"{\\"cmd\\":\\"echo 1\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
        `data: [DONE]\n\n`,
      ];

      async function* generateChunks() {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          yield encoder.encode(chunk);
        }
      }

      const mockOpenAIResponse = {
        body: generateChunks(),
      };

      const events = [];
      const mockRes = new EventEmitter();
      mockRes.writeHead = () => {};
      mockRes.write = (text) => {
        const lines = text.trim().split("\n");
        let eventName = null;
        let eventData = null;
        for (const l of lines) {
          if (l.startsWith("event: ")) eventName = l.slice(7);
          if (l.startsWith("data: ")) eventData = JSON.parse(l.slice(6));
        }
        if (eventName && eventData) {
          events.push({ event: eventName, data: eventData });
        }
      };
      mockRes.end = () => {};

      await streamOpenAIToAnthropic(mockOpenAIResponse, mockRes, { model: "gemini-2.5-flash" });

      const eventTypes = events.map((e) => e.event);
      assert.ok(eventTypes.includes("message_start"));
      assert.ok(eventTypes.includes("content_block_start"));
      assert.ok(eventTypes.includes("content_block_delta"));
      assert.ok(eventTypes.includes("content_block_stop"));
      assert.ok(eventTypes.includes("message_delta"));
      assert.ok(eventTypes.includes("message_stop"));

      // Check text delta
      const textDeltas = events.filter((e) => e.data.delta?.type === "text_delta");
      assert.equal(textDeltas.map((e) => e.data.delta.text).join(""), "Hello world");

      // Check tool delta
      const toolStart = events.find((e) => e.data.content_block?.type === "tool_use");
      assert.ok(toolStart);
      assert.equal(toolStart.data.content_block.name, "Bash");

      // Check message delta stop reason
      const messageDelta = events.find((e) => e.event === "message_delta");
      assert.equal(messageDelta.data.delta.stop_reason, "tool_use");
    });
  });
});
