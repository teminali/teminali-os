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
import { buildCommandEvidence, parseAgentCommands } from "../src/services/agentCommands.ts";
import { parseWorkspaceEdits } from "../src/services/liveEditProtocol.ts";
import { askQuestionsFrom, parseAskToolCalls } from "../src/services/askToolCalls.ts";

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

/** One real command result, in the shape `buildCommandEvidence` receives from the engine. */
const ran = (command, output) => ({ command, risk: "safe", executed: true, code: 0, output, truncated: false });

const playerChat = [
  { role: "user", content: "what's open right now?" },
  { role: "assistant", content: "Halo by Beyoncé is open in the player, paused at the start." },
];

const noFence = (text) =>
  parsePlayerToolCalls(text).length === 0 && parseVideoToolCalls(text).length === 0 && parseAgentCommands(text).length === 0
  && asked(text).length === 0;
/** The questions a reply actually put to the operator, as the engine would read them. */
const asked = (text) => askQuestionsFrom(parseAskToolCalls(text));
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
    // The editor's second case, and the reason it exists: `patch_clip`'s
    // description carries dotted-path *examples*, and those examples are
    // exactly what a naive "keep the first sentence" trim would delete. The
    // history already holds a `describe_timeline` result, so the honest move
    // is a direct edit rather than another read.
    name: "editor-patch-clip",
    history: [
      { role: "user", content: "what's on my timeline?" },
      { role: "assistant", content: 'Reading the timeline.\n```video-tool\n{"tool":"describe_timeline","arguments":{}}\n```' },
      { role: "user", content: '[tool result] Track V1 — clip id "c3", name "intro.mp4", start 0ms, duration 4000ms.' },
    ],
    prompt: "rotate c3 by 45 degrees",
    expect: (text) => {
      const calls = parseVideoToolCalls(text);
      const patch = calls.find((r) => r.tool === "patch_clip");
      if (!patch) return `tools=${calls.map((r) => r.tool).join(",") || "none"}`;
      const args = JSON.stringify(patch.arguments ?? {});
      if (!/rotation/i.test(args)) return `no rotation property: ${args.slice(0, 90)}`;
      if (!/45/.test(args)) return `not 45 degrees: ${args.slice(0, 90)}`;
      return null;
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
    // The ask contract. The operator asked for a choice in so many words, so
    // a reply that picks one for them has ignored the request, and a reply
    // that lists three in prose has ended the turn with nothing to click.
    name: "ask-explicit-choice",
    history: [],
    prompt: "I can't decide how to structure this project. Give me a few options and let me pick one.",
    expect: (text) => {
      const questions = asked(text);
      if (questions.length === 0) return `no ask fence; said: ${text.replace(/\s+/g, " ").slice(0, 90)}`;
      const first = questions[0];
      if (first.options.length < 2) return `only ${first.options.length} option(s)`;
      if (commands(text).length) return `ran a command instead of asking: ${commands(text)[0]}`;
      return null;
    },
  },
  {
    // KNOWN GAP, deliberately left red. With a file open in the player on an
    // 8k window the ask block does not fit and `assemblePrompt` skips it, so
    // the lane cannot ask. Shortening the block to 389 chars made it fit and
    // scored 0/3 anyway — the model listed options in prose with the rule in
    // front of it — so the block kept its length and this case keeps its
    // failure. It is the regression test for trimming the editor catalogue,
    // which is 4,062 chars and is what actually crowds this out.
    name: "ask-with-player",
    player: halo(true),
    history: playerChat,
    prompt: "I can't decide how to structure this project. Give me a few options and let me pick one.",
    expect: (text) => {
      const questions = asked(text);
      if (questions.length === 0) return `no ask fence; said: ${text.replace(/\s+/g, " ").slice(0, 90)}`;
      return questions[0].options.length >= 2 ? null : `only ${questions[0].options.length} option(s)`;
    },
  },
  {
    // The other half of the contract, and the one that decides whether it is
    // worth having: a tool for asking makes a model ask for what it could
    // have measured. The branch is one `git` call away and must never be a
    // question.
    name: "ask-not-for-knowable",
    history: [],
    prompt: "what branch am I on?",
    expect: (text) => {
      const questions = asked(text);
      if (questions.length) return `asked instead of measuring: "${questions[0].question}"`;
      return commands(text).some((c) => /\bgit\b/.test(c)) ? null : `commands=${commands(text).join(" | ") || "none"}`;
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
  {
    /*
      The edit that cannot be made by rewriting. `parseWorkspaceEdits` applies a
      whole-file `path=` block by overwriting, which is right for a file the
      model authored and destructive for one it has only seen a line of: here it
      has been shown line 42 of 812 and knows the count. Any `path=` block for
      that file is therefore an 811-line deletion, not an edit, and the window
      makes this the common case rather than the rare one — the base prompt's
      "emit every intended final file as a complete fenced block" is a rule the
      lane cannot follow on real code.

      So the case is graded on damage, not on style: a surgical command passes,
      prose fails, and a whole-file block fails hardest because the engine would
      have executed it.
    */
    name: "edit-long-file",
    history: [
      { role: "user", content: "what port does the gateway listen on?" },
      { role: "assistant", content: '```frontier-run\ngrep -n "port" server/config.js\nwc -l server/config.js\n```' },
      {
        role: "user",
        content: buildCommandEvidence([
          ran('grep -n "port" server/config.js', "42:  port: Number(process.env.PORT ?? 3000),"),
          ran("wc -l server/config.js", "     812 server/config.js"),
        ]),
      },
      { role: "assistant", content: "It listens on 3000 — server/config.js:42, with PORT overriding it." },
    ],
    prompt: "change that default to 4310",
    expect: (text) => {
      const prompt = "change that default to 4310";
      const clobber = parseWorkspaceEdits(text, { userPrompt: prompt }).find((e) => /config\.js$/.test(e.path));
      if (clobber) return `would overwrite ${clobber.path} with ${clobber.content.split("\n").length} of its 812 lines`;
      const surgical = commands(text).filter((c) => /config\.js/.test(c) && /4310/.test(c));
      return surgical.length ? null : `commands=${commands(text).join(" | ") || "none"}`;
    },
  },
  {
    /*
      The URL is in the prompt, so there is nothing to search for and nothing
      to recall: the only honest reply reaches for the network. This grades the
      failure [LIVE DATA] was written against, in the shape that block does not
      name — an arbitrary page rather than one of its listed API hosts.

      It scored 3/3 the first time it was run, and that pass was hollow: the
      model's half already worked, and the *pipeline* was the broken half. A
      `curl` of this page returns 295,973 chars of HTML, of which the runner
      kept the first few thousand — measured to contain zero occurrences of
      "LTS" and no version number, i.e. the `<head>`. The case stays as the
      regression test for the model's half; the pipeline's half is fixed in
      `readablePage.ts` and tested in `tests/readable-page.test.mjs`, because
      the eval grades a turn and cannot see what a command returned.
    */
    name: "web-fetch-url",
    history: [],
    prompt: "read https://nodejs.org/en/about/previous-releases and tell me which Node version is the current LTS",
    expect: (text) => {
      if (commands(text).some((c) => /nodejs\.org/.test(c))) return null;
      const refused = says(text, ["I cannot", "I can't", "I don't have access", "I'm unable", "check a website", "visit the"]);
      if (refused.length) return `refused: "${refused[0]}"`;
      return `did not fetch the page; commands=${commands(text).join(" | ") || "none"}`;
    },
  },
  {
    /*
      KNOWN GAP, deliberately left red, and the grader is not to be loosened to
      make it green. No URL, no listed API host, and no single repo to
      interrogate — the shape [LIVE DATA] does not cover.

      The reason it cannot pass is not the model: there is no credential-free
      web search reachable from this machine. All measured 2026-09-07 —
      `html.duckduckgo.com` and `lite.duckduckgo.com` return **403** to curl;
      `api.duckduckgo.com` (Instant Answer) returns 200 with **0 bytes** for a
      real query; `searx.be/search?format=json` returns an HTML block page, not
      JSON; `s.jina.ai` returns **401**, key required. Do not re-test these
      without a reason.

      So the model's two passing runs were hollow in the same way `web-fetch-url`
      was — a search-shaped host whose output is an error page. Closing this
      needs an operator-supplied API key, which is a product decision, not a
      prompt fix. `r.jina.ai` (read a URL, no key) does work, and is the fallback
      worth considering if local stripping ever proves insufficient.
    */
    name: "web-search-open",
    history: [],
    prompt: "search the web for recent blog posts about running local LLMs on Apple silicon and tell me what the top few say",
    expect: (text) => {
      const ran = commands(text);
      if (ran.some((c) => /duckduckgo|bing\.com|google\.com\/search|searx|search\.brave|r\.jina\.ai|api\.search/i.test(c))) return null;
      const refused = says(text, ["I cannot", "I can't", "I don't have access", "I'm unable", "check a website", "browse the"]);
      if (refused.length) return `refused: "${refused[0]}"`;
      return `no search; commands=${ran.join(" | ") || "none"}`;
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
    // The host the eval stands in for has a picker on screen; a case opts out.
    canAsk: c.canAsk !== false,
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
