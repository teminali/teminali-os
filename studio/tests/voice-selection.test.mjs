/**
 * The voice picker did nothing. `sendVoiceChange` set the voice and reopened
 * the session, and the fresh token's `voice` ("Sulafat", a gateway constant)
 * was adopted on connect, so every pick was undone before the setup was sent.
 * The pick was also never handed to the engine at launch, and never saved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const saved = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key) => (saved.has(key) ? saved.get(key) : null),
    setItem: (key, value) => saved.set(key, String(value)),
  },
});

const { GeminiLiveEngine } = await import("../src/services/voice/geminiLiveEngine.ts");
const { TEMI_PERSONA, RECALL_INSERT_BEFORE, TEMI_DEFAULT_VOICE } = await import("../src/services/voice/temiPersona.ts");
const { useAssistantActivityStore, readSavedVoice } = await import("../src/store/assistantActivityStore.ts");

const engineSource = await readFile(new URL("../src/services/voice/geminiLiveEngine.ts", import.meta.url), "utf8");

test("the engine opens in the voice it was given, and the default without one", () => {
  assert.equal(new GeminiLiveEngine({ voice: "Aoede" }).voice, "Aoede");
  assert.equal(new GeminiLiveEngine().voice, TEMI_DEFAULT_VOICE);
  assert.equal(new GeminiLiveEngine({ voice: "  " }).voice, TEMI_DEFAULT_VOICE);
});

test("a minted token's voice never overwrites the chosen one", () => {
  const code = engineSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /this\.voice\s*=\s*result\.voice/);
  assert.match(code, /prebuiltVoiceConfig: \{ voiceName: this\.voice \}/);
});

test("the stage hands the saved pick to the engine it builds", async () => {
  const stage = await readFile(new URL("../src/components/voice/TemiVoiceStage.tsx", import.meta.url), "utf8");
  assert.match(stage, /new GeminiLiveEngine\(\{ voice: useAssistantActivityStore\.getState\(\)\.selectedVoice \}\)/);
});

test("a picked voice is saved and read back; a retired Kokoro key is not", () => {
  useAssistantActivityStore.getState().setSelectedVoice("Gacrux");
  assert.equal(saved.get("temi.voice"), "Gacrux");
  assert.equal(readSavedVoice(), "Gacrux");

  saved.set("temi.voice", "royal_velvet");
  assert.equal(readSavedVoice(), "Sulafat");
});

test("the persona carries the audition's accent, and the examples stay last", () => {
  const heading = "THE VOICE YOU SPEAK IN:";
  assert.ok(TEMI_PERSONA.includes(heading));
  assert.match(TEMI_PERSONA, /Italian accent/);
  assert.ok(TEMI_PERSONA.indexOf(heading) < TEMI_PERSONA.indexOf(RECALL_INSERT_BEFORE));
});
