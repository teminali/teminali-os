/**
 * The local-lane eval: a fixed set of turns, the real prompt, the real model,
 * and a number that has to go up.
 *
 * Every case is graded by the code's own parsers — `parsePlayerToolCalls`,
 * `parseVideoToolCalls`, `parseAgentCommands`, `parseWorkspaceEdits` — so a
 * fence the harness accepts is one the engine would have executed. The system
 * prompt is `composeSystemPrompt`, the function the engine calls, under the
 * budget the engine would use for this model's window.
 *
 *   npm run eval:local                      the default model, two runs a case
 *   npm run eval:local -- --runs 3          more runs per case
 *   npm run eval:local -- --only player     cases whose name contains "player"
 *   npm run eval:local -- --unbudgeted      the pre-budget prompt, for the A/B
 *   EVAL_MODEL=frontier-gpt-oss-20b-32k npm run eval:local
 *
 * It needs Ollama on 127.0.0.1:11434 with the model installed, and it is a
 * measurement, not a test: it never fails the build. Pass `--gate 0.8` to
 * exit 1 below a score.
 */
import { budgetFor } from "../src/services/contextBudget.ts";
import { composeSystemPrompt } from "../src/services/systemPrompt.ts";
import { LOCAL_PLAYER_ACTIONS, describeLivePlayer, parsePlayerToolCalls } from "../src/services/playerToolCalls.ts";
import { parseVideoToolCalls } from "../src/services/videoToolCalls.ts";
import { parseAgentCommands } from "../src/services/agentCommands.ts";
import { parseWorkspaceEdits } from "../src/services/liveEditProtocol.ts";

const { videoToolSummaries } = await import("./.build/tool-manifest.mjs");

/* ── Arguments ─────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] ?? fallback : fallback;
};
const RUNS = Number(flag("--runs", "2"));
const ONLY = flag("--only", "");
const UNBUDGETED = args.includes("--unbudgeted");
const GATE = Number(flag("--gate", "0"));
const MODEL = process.env.EVAL_MODEL ?? "frontier-qwen2.5-coder-14b-8k";
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

/** The window a `frontier-*` build pins, read the way the catalogue reads it. */
const pinned = /-(\d+)k(?::latest)?$/i.exec(MODEL);
const WINDOW = Number(process.env.EVAL_CTX ?? (pinned ? Number(pinned[1]) * 1024 : 8192));

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const halo = (playing) => ({
  view: "player",
  path: "/Users/op/Music/Beyoncé/Halo.mp4",
  title: "Beyoncé — Halo",
  kind: "video",
  series: { folder: "/Users/op/Music/Beyoncé", title: "Beyoncé", index: 1, count: 12, episodes: [] },
  playing,
  ended: false,
  time: playing ? 42 : 0,
  duration: 224,
  volume: 0.8,
  muted: false,
  rate: 1,
  subtitles: { available: [], active: null },
  fullscreen: false,
  error: null,
});

const playerChat = [
  { role: "user", content: "what's open right now?" },
  { role: "assistant", content: "Halo by Beyoncé is open in the player, paused at the start." },
];

const noFence = (text) =>
  parsePlayerToolCalls(text).length === 0 && parseVideoToolCalls(text).length === 0 && parseAgentCommands(text).length === 0;
const playerActions = (text) =>
  parsePlayerToolCalls(text).filter((r) => "command" in r).map((r) => r.command.action);
const commands = (text) => parseAgentCommands(text).map((r) => r.command);
const says = (text, phrases) => phrases.filter((p) => text.toLowerCase().includes(p.toLowerCase()));

/**
 * Each case is one turn. `expect` returns the reason it failed, or null.
 * The names are what `--only` matches on.
 */
const CASES = [
  {
    name: "player-play",
    player: halo(false),
    history: playerChat,
    prompt: "play a beyonce song",
    expect: (text) => {
      const actions = playerActions(text);
      if (!actions.some((a) => ["play", "toggle", "episode"].includes(a))) return `no play/episode fence; actions=${actions.join(",") || "none"}`;
      if (text.includes("/path/to")) return "invented a path";
      if (commands(text).length) return `ran a command instead: ${commands(text)[0]}`;
      return null;
    },
  },
  {
    name: "player-pause",
    player: halo(true),
    history: playerChat,
    prompt: "pause it",
    expect: (text) => (playerActions(text).some((a) => ["pause", "toggle"].includes(a)) ? null : `actions=${playerActions(text).join(",") || "none"}`),
  },
  {
    name: "player-louder",
    player: halo(true),
    history: playerChat,
    prompt: "turn it up a bit",
    expect: (text) => {
      const req = parsePlayerToolCalls(text).find((r) => "command" in r && r.command.action === "volume");
      if (!req) return `no volume fence; actions=${playerActions(text).join(",") || "none"}`;
      const v = Number(req.command.value);
      return v > 0.8 && v <= 1 ? null : `volume ${v} is not a bit above 0.8`;
    },
  },
  {
    name: "player-status",
    player: halo(true),
    history: [],
    prompt: "what's playing right now?",
    expect: (text) => {
      if (commands(text).length) return "reached for the shell to answer a player question";
      if (!/halo/i.test(text) && !playerActions(text).includes("status")) return "did not name the file or read the player";
      return null;
    },
  },
  {
    name: "timeline-describe",
    history: [],
    prompt: "what's on my timeline?",
    expect: (text) => {
      const tools = parseVideoToolCalls(text).map((r) => r.tool);
      return tools.includes("describe_timeline") ? null : `tools=${tools.join(",") || "none"}`;
    },
  },
  {
    name: "command-disk",
    history: [],
    prompt: "how much free disk space do I have?",
    expect: (text) => (commands(text).some((c) => /\bdf\b|diskutil/.test(c)) ? null : `commands=${commands(text).join(" | ") || "none"}`),
  },
  {
    name: "command-branch",
    history: [],
    prompt: "what branch am I on?",
    expect: (text) => (commands(text).some((c) => /\bgit\b/.test(c)) ? null : `commands=${commands(text).join(" | ") || "none"}`),
  },
  {
    name: "command-live-data",
    history: [],
    prompt: "what's the bitcoin price right now?",
    expect: (text) => {
      if (commands(text).length === 0) return `no fence; said: ${text.slice(0, 80)}`;
      const refused = says(text, ["I cannot", "I can't", "I don't have access", "check a website"]);
      return refused.length ? `refused: "${refused[0]}"` : null;
    },
  },
  {
    // The real-world shape of the failure the budget exists for: a file open
    // in the player, and a question that needs the network. Both blocks must
    // fit alongside the live-data rule or the model refuses.
    name: "command-live-data-with-player",
    player: halo(true),
    history: playerChat,
    prompt: "what's the bitcoin price right now?",
    expect: (text) => {
      if (commands(text).length === 0) return `no fence`;
      const refused = says(text, ["I cannot", "I can't", "I don't have access", "I don't have real-time", "check a website"]);
      return refused.length ? `refused: "${refused[0]}"` : null;
    },
  },
  {
    name: "chat-greeting",
    history: [],
    prompt: "hello",
    expect: (text) => {
      if (!noFence(text)) return "ran something in reply to hello";
      const ack = says(text, ["I'm on it", "On it", "Working on it", "Right away"]);
      return ack.length ? `work acknowledgement: "${ack[0]}"` : null;
    },
  },
  {
    name: "chat-identity",
    history: [],
    prompt: "what's your name?",
    expect: (text) => {
      if (!/temy/i.test(text)) return `did not say Temy: ${text.slice(0, 80)}`;
      if (/qwen|llama|gpt/i.test(text)) return "named the model underneath";
      return null;
    },
  },
  {
    name: "file-write",
    history: [],
    prompt: "create hello.py that prints hi",
    expect: (text) => {
      const edits = parseWorkspaceEdits(text, { userPrompt: "create hello.py that prints hi" });
      if (!edits.some((e) => /hello\.py$/.test(e.path))) return `paths=${edits.map((e) => e.path).join(",") || "none"}`;
      return /print\(/.test(text) ? null : "no print call";
    },
  },
].filter((c) => !ONLY || c.name.includes(ONLY));

/* ── The turn ──────────────────────────────────────────────────────────────── */

const tools = videoToolSummaries();
const budget = budgetFor("frontier", WINDOW);

function systemFor(c) {
  return composeSystemPrompt({
    label: "Flash",
    skillInstruction: "",
    // The host advertises the editor on every turn; a case opts out, not in.
    videoTools: c.videoTools === false ? undefined : tools,
    player: c.player ? { actions: LOCAL_PLAYER_ACTIONS, showing: describeLivePlayer(c.player) } : null,
    origin: "text",
    freshConversation: c.history.length === 0,
    budgetChars: UNBUDGETED ? Number.MAX_SAFE_INTEGER : budget.systemPromptChars,
  });
}

async function ask(c) {
  const system = systemFor(c);
  const started = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      keep_alive: "10m",
      // The engine's own sampling, so the eval measures the engine's turn.
      options: { num_ctx: WINDOW, num_batch: 128, temperature: 0.15, num_predict: 400 },
      messages: [{ role: "system", content: system.text }, ...c.history, { role: "user", content: c.prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    text: json.message?.content ?? "",
    promptTokens: json.prompt_eval_count ?? 0,
    ms: Date.now() - started,
    dropped: system.dropped,
  };
}

/* ── Run ───────────────────────────────────────────────────────────────────── */

console.log(`model ${MODEL} · window ${WINDOW} · ${UNBUDGETED ? "UNBUDGETED prompt" : `system budget ${budget.systemPromptChars} chars`} · ${RUNS} run(s) a case\n`);

let passes = 0;
let total = 0;
const rows = [];
for (const c of CASES) {
  const results = [];
  for (let i = 0; i < RUNS; i += 1) {
    const r = await ask(c);
    const why = c.expect(r.text);
    results.push({ ...r, why: why ? `${why} — said: ${JSON.stringify(r.text.replace(/\s+/g, " ").slice(0, 110))}` : null });
    total += 1;
    if (!why) passes += 1;
  }
  const ok = results.filter((r) => !r.why).length;
  const tokens = results[0].promptTokens;
  const ms = Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length);
  rows.push({ name: c.name, ok, runs: RUNS, promptTokens: tokens, ms, dropped: results[0].dropped });
  const mark = ok === RUNS ? "✔" : ok === 0 ? "✖" : "◐";
  const dropped = results[0].dropped.length ? `   dropped: ${results[0].dropped.join(", ")}` : "";
  console.log(`${mark} ${c.name.padEnd(30)} ${ok}/${RUNS}   prompt ${String(tokens).padStart(5)} tok   ${String(ms).padStart(6)} ms${dropped}`);
  for (const r of results.filter((r) => r.why)) console.log(`    ↳ ${r.why}`);
}

const score = total ? passes / total : 0;
console.log(`\nscore ${passes}/${total} = ${(score * 100).toFixed(0)}%`);
console.log(JSON.stringify({ model: MODEL, window: WINDOW, unbudgeted: UNBUDGETED, runs: RUNS, passes, total, score, cases: rows }));
if (GATE && score < GATE) process.exit(1);
