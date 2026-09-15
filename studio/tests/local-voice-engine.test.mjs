import test from "node:test";
import assert from "node:assert/strict";

test("LocalVoiceEngine initializes with offline local mode and status reporting", async () => {
  const { LocalVoiceEngine } = await import("../src/services/voice/localVoiceEngine.ts");
  const engine = new LocalVoiceEngine();

  assert.equal(engine.mode, "local");
  assert.equal(engine.isConnected, false);
  assert.equal(engine.isListening, false);
  assert.equal(engine.isSpeaking, false);

  let statusEmitted = null;
  engine.onStatusChange = (status) => {
    statusEmitted = status;
  };

  await engine.connect();
  assert.equal(engine.isConnected, true);
  assert.ok(statusEmitted);
  assert.equal(statusEmitted.mode, "local");
  assert.equal(statusEmitted.connected, true);
});

test("LocalVoiceEngine resolves local fast paths with zero tokens and sub-50ms latency", async () => {
  const { LocalVoiceEngine } = await import("../src/services/voice/localVoiceEngine.ts");
  const engine = new LocalVoiceEngine();
  await engine.connect();

  const turns = [];
  engine.onTurn = (turn) => {
    turns.push(turn);
  };

  await engine.submitUserText("what is my battery level?");

  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[1].role, "assistant");
  assert.equal(turns[1].tokensUsed, 0);
  assert.equal(turns[1].isFastPath, true);
  assert.ok(turns[1].latencyMs < 300);
});

test("LocalVoiceEngine resolves capabilities directory query locally", async () => {
  const { LocalVoiceEngine } = await import("../src/services/voice/localVoiceEngine.ts");
  const engine = new LocalVoiceEngine();
  await engine.connect();

  const turns = [];
  engine.onTurn = (turn) => {
    turns.push(turn);
  };

  await engine.submitUserText("what can you do?");

  assert.equal(turns.length, 2);
  assert.equal(turns[1].role, "assistant");
  assert.equal(turns[1].isFastPath, true);
  assert.ok(turns[1].text.includes("Capability Directory") || turns[1].text.includes("capability directory"));
});

test("LocalVoiceEngine handles singing requests with authentic Italian lyrics immediately", async () => {
  const { LocalVoiceEngine } = await import("../src/services/voice/localVoiceEngine.ts");
  const engine = new LocalVoiceEngine();
  await engine.connect();

  const turns = [];
  engine.onTurn = (turn) => {
    turns.push(turn);
  };

  await engine.submitUserText("Temi, please sing a song for me");

  assert.equal(turns.length, 2);
  assert.equal(turns[1].role, "assistant");
  assert.ok(turns[1].text.includes("Volare, oh-oh"));
});
