import test from "node:test";
import assert from "node:assert/strict";
import { chooseEngines } from "../server/voice.js";
import { rankLocalModel, buildPrompt, MODEL_PREFERENCE } from "../server/speech-local.js";

const sidecarBase = { asr: { model: "onnx-community/whisper-base" }, tts: { model: "Breeze-TTS-2" } };
const localTurbo = { available: true, modelName: "ggml-large-v3-turbo-q8_0.bin", rank: 5, multilingual: true };
const localBase = { available: true, modelName: "ggml-base.bin", rank: 2, multilingual: true };
const sayTts = { available: true, voices: [{ name: "Daniel", language: "en-GB" }] };
const breezeTts = { available: true, model: "breeze-tts-2-q8_0", voices: ["bella"] };

test("a better local model takes recognition from the sidecar", () => {
  const chosen = chooseEngines({ sidecar: sidecarBase, localAsr: localTurbo, localTts: sayTts });
  assert.equal(chosen.asr.source, "local");
});

test("Breeze synthesis beats `say`, whoever is listening", () => {
  const chosen = chooseEngines({ localAsr: localTurbo, breezeTts, localTts: sayTts });
  assert.equal(chosen.tts.source, "breeze", "Breeze beats `say`");
});

test("synthesis stays with the sidecar even when recognition does not", () => {
  const chosen = chooseEngines({ sidecar: sidecarBase, localAsr: localTurbo, localTts: sayTts });
  assert.equal(chosen.tts.source, "sidecar");
});

test("a weaker local model leaves recognition with the sidecar", () => {
  const chosen = chooseEngines({ sidecar: sidecarBase, localAsr: localBase, localTts: sayTts });
  assert.equal(chosen.asr.source, "sidecar");
});

test("the operator's preference overrides rank in both directions", () => {
  assert.equal(chooseEngines({ sidecar: sidecarBase, localAsr: localTurbo, preference: "sidecar" }).asr.source, "sidecar");
  assert.equal(chooseEngines({ sidecar: sidecarBase, localAsr: localBase, preference: "local" }).asr.source, "local");
});

test("a sidecar serving only synthesis does not capture the microphone", () => {
  const chosen = chooseEngines({ sidecar: { asr: null, tts: { model: "Breeze-TTS-2" } }, localAsr: localBase, localTts: sayTts });
  assert.equal(chosen.asr.source, "local", "the only recogniser present must get the audio");
  assert.equal(chosen.tts.source, "sidecar");
});

test("a sidecar serving only recognition still gets the audio", () => {
  const chosen = chooseEngines({ sidecar: { asr: { model: "whisper-base" }, tts: null }, localAsr: null, localTts: sayTts });
  assert.equal(chosen.asr.source, "sidecar");
  assert.equal(chosen.tts.source, "local");
});

test("nothing available is nothing chosen", () => {
  const chosen = chooseEngines({});
  assert.equal(chosen.asr, null);
  assert.equal(chosen.tts, null);
});

test("a preference for an engine that is not there falls back rather than failing", () => {
  const chosen = chooseEngines({ sidecar: null, localAsr: localBase, preference: "sidecar" });
  assert.equal(chosen.asr.source, "local");
});

test("model rank orders the families, and a quantised file ranks with its parent", () => {
  assert.ok(rankLocalModel("ggml-large-v3-turbo-q8_0.bin") > rankLocalModel("ggml-base.bin"));
  assert.equal(rankLocalModel("ggml-small-q5_1.bin"), rankLocalModel("ggml-small.bin"));
  assert.ok(rankLocalModel("ggml-medium.bin") > rankLocalModel("ggml-small.bin"));
  assert.equal(rankLocalModel("nonsense.bin"), 0);
});

test("the preference list ranks its own entries in descending order", () => {
  const ranks = MODEL_PREFERENCE.filter((name) => !/\.en\./.test(name)).map(rankLocalModel);
  const large = ranks.indexOf(6) === -1 ? Infinity : ranks.indexOf(6);
  assert.ok(ranks[0] >= 5, "the best model must be first");
  assert.ok(large < ranks.length, "large must appear");
});

test("the vocabulary prompt leads with the caller's own names", () => {
  const prompt = buildPrompt(["dukabot", "m-digital-web"]);
  assert.ok(prompt.startsWith("dukabot, m-digital-web"), prompt);
  assert.ok(prompt.includes("Teminali"), "the domain terms follow");
  assert.ok(prompt.endsWith("."));
});

test("the prompt stays inside whisper's cap and never repeats a word", () => {
  const prompt = buildPrompt(Array.from({ length: 400 }, (_, i) => `folder${i}`));
  assert.ok(prompt.length <= 601, `prompt was ${prompt.length}`);
  const words = prompt.replace(/\.$/, "").split(", ");
  assert.equal(new Set(words.map((w) => w.toLowerCase())).size, words.length);
});

test("a hint that is already a domain term is not said twice", () => {
  const prompt = buildPrompt(["teminali"]);
  const words = prompt.toLowerCase().replace(/\.$/, "").split(", ");
  assert.equal(words.filter((w) => w === "teminali").length, 1);
});

test("junk hints are dropped rather than poisoning the prompt", () => {
  const prompt = buildPrompt(["", "   ", null, undefined, "x".repeat(200), "good-name"]);
  assert.ok(prompt.includes("good-name"));
  assert.ok(!prompt.includes("x".repeat(60)));
});
