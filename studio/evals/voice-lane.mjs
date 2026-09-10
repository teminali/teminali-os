/**
 * The voice lane vs the real model — a score, not a pass/fail.
 *
 * `evals/local-lane.mjs` scores the *chat* agent: does it emit the right tool
 * fence for an instruction. This scores the *voice* co-agent, which has the
 * opposite job — it must answer a spoken question about a run that is already
 * in flight, **without touching the run**, from nothing but the digest.
 *
 * The 19 rule tests in `tests/voice-co-runner.test.mjs` pin the routing and the
 * digest. They cannot pin the thing that actually matters here, because it is a
 * property of the model's prose and not of the code: is the answer *true of the
 * digest*, and is it short enough to say out loud. That is what this measures.
 *
 * Four graders run on every case:
 *   - `source` is "model", not "rules" — otherwise we are scoring
 *     `summariseProgress`, which the rule tests already cover.
 *   - the answer names something that is really in the run.
 *   - the answer invents no file that is not in the run. This is the one that
 *     matters: a confident wrong filename spoken aloud is worse than silence.
 *   - it is speakable — inside `MAX_SENTENCES`, no markdown, not a paragraph.
 *
 * Answers are compared in their *spoken* form. `explainRun` pipes its output
 * through `speakablePath`, so `Composer.tsx` reaches the ear as
 * "Composer dot tsx" and a grader matching the raw filename would score every
 * correct answer as a miss.
 *
 * Usage:
 *   npm run eval:voice
 *   npm run eval:voice -- --runs 3 --only explain-failing-command
 *   EVAL_MODEL=qwen2.5:7b npm run eval:voice
 *
 * It needs Ollama on 127.0.0.1:11434 with the model installed, and — like the
 * local-lane eval — it wants the GPU to itself. Run one eval at a time.
 */
import { explainRun, MAX_SENTENCES } from "../src/services/voice/coRunner.ts";
import { speakablePath } from "../src/services/voice/progressNarration.ts";

/* ── Flags ─────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const RUNS = Number(flag("--runs", "2"));
const ONLY = flag("--only", "");
const GATE = Number(flag("--gate", "0"));
const MODEL = process.env.EVAL_MODEL ?? "qwen3:8b";
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const WINDOW = Number(process.env.EVAL_CTX ?? 8192);

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

// A fixed clock so the digest's elapsed times are identical on every run and a
// failure is the model's, never the wall clock's.
const NOW = 1_700_000_000_000;
const ago = (ms) => NOW - ms;

const call = (id, name, args, status, result) => ({ id, name, arguments: args, status, ...(result ? { result } : {}) });

/** A test run that has just gone red. The operator asks what broke. */
const failingTests = {
  startedAt: ago(42_000),
  engine: "frontier",
  toolCalls: [
    call("1", "Bash", { command: "npm run studio:test" }, "completed",
      "FAIL tests/voice-sync.test.mjs\n  ✖ a caption that never commits\n  1 failing, 1774 passing"),
  ],
  lastText: "The suite is red. One test in the voice sync file is failing.",
};

/** A sequence of edits. The operator asks which file was touched. */
const editSequence = {
  startedAt: ago(96_000),
  engine: "frontier",
  toolCalls: [
    call("1", "Read", { file_path: "studio/src/services/voice/conversation.ts" }, "completed", "1400 lines"),
    call("2", "Edit", { file_path: "studio/src/services/voice/conversation.ts" }, "completed", "applied"),
    call("3", "Read", { file_path: "studio/src/components/chat/Composer.tsx" }, "completed", "260 lines"),
  ],
  lastText: "Reading the composer to see how it commits a turn.",
};

/** A command that errored. The operator asks whether it worked. */
const failingCommand = {
  startedAt: ago(18_000),
  engine: "claude",
  toolCalls: [
    call("1", "Bash", { command: "npm run typecheck" }, "error",
      "src/services/voice/conversation.ts(412,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."),
  ],
  lastText: "",
};

/** A run still in its first tool call, with nothing to report yet. */
const justStarted = {
  startedAt: ago(3_000),
  engine: "frontier",
  toolCalls: [call("1", "Grep", { pattern: "endpointSilenceMs" }, "running")],
  lastText: "",
};

/* ── Graders ───────────────────────────────────────────────────────────────── */

/** Every path the run really touched, in the form the answer will speak it. */
const spokenPaths = (run) =>
  run.toolCalls
    .map((c) => c.arguments.file_path ?? c.arguments.path ?? c.arguments.file)
    .filter((p) => typeof p === "string")
    .map((p) => speakablePath(p).toLowerCase());

/** "Composer dot tsx", "conversation dot ts" — a filename as it is spoken. */
const SPOKEN_FILE = /\b([a-z0-9]+(?:[ -][a-z0-9]+)*? dot [a-z0-9]+(?: dot [a-z0-9]+)*)\b/gi;

const has = (text, phrase) => text.toLowerCase().includes(phrase.toLowerCase());

/** Any filename the answer speaks that the run never touched. */
function invented(text, run) {
  const allowed = spokenPaths(run);
  const said = [...text.matchAll(SPOKEN_FILE)].map((m) => m[1].toLowerCase().trim());
  return said.filter((s) => !allowed.some((a) => a.includes(s) || s.includes(a)));
}

function sentences(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Applied to every case, on top of the case's own expectation. */
function shared(text, source, run) {
  if (source !== "model") return "fell back to the rules — the model gave nothing usable";
  if (!text.trim()) return "empty answer";
  if (/[`*#]|^\s*[-•]\s/m.test(text)) return `spoke markdown: ${JSON.stringify(text.slice(0, 60))}`;
  if (sentences(text).length > MAX_SENTENCES) return `${sentences(text).length} sentences, max is ${MAX_SENTENCES}`;
  if (text.split(/\s+/).length > 70) return `${text.split(/\s+/).length} words — too long to speak`;
  const bogus = invented(text, run);
  if (bogus.length) return `invented a file: ${bogus.join(", ")}`;
  return null;
}

/* ── Cases ─────────────────────────────────────────────────────────────────── */

const CASES = [
  {
    name: "explain-failing-tests",
    run: failingTests,
    question: "what broke?",
    // It must name the failing suite, not the 1774 that passed.
    expect: (text) =>
      has(text, "voice") || has(text, "sync") || has(text, "test")
        ? null
        : "did not say which suite failed",
  },
  {
    name: "explain-which-file",
    run: editSequence,
    question: "which file are you changing?",
    expect: (text) =>
      has(text, "conversation") ? null : "did not name conversation.ts, the file it edited",
  },
  {
    name: "explain-failing-command",
    run: failingCommand,
    question: "did that work?",
    // The honest answer is no. A cheerful yes is the failure this case exists for.
    expect: (text) => {
      const negative = /\b(no|not|fail|failed|error|did ?n[o']t|couldn'?t|broke)\b/i.test(text);
      return negative ? null : "reported a failed command as if it succeeded";
    },
  },
  {
    name: "explain-nothing-yet",
    run: justStarted,
    question: "what did the tests say?",
    // The digest has no test result. Admitting that beats inventing one.
    expect: (text) => {
      const admits = /\b(not|no|yet|hasn'?t|have ?n[o']t|still|cannot|can'?t|don'?t know|nothing)\b/i.test(text);
      return admits ? null : "claimed a test result the run has not produced";
    },
  },
  {
    name: "explain-what-now",
    run: editSequence,
    question: "what are you doing right now?",
    expect: (text) =>
      has(text, "read") || has(text, "compos") || has(text, "edit") || has(text, "look")
        ? null
        : "did not describe the current step",
  },
];

/* ── The model the co-agent is lent ────────────────────────────────────────── */

let lastMs = 0;
let lastTokens = 0;
let lastThought = false;

async function complete(prompt, signal) {
  const started = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      keep_alive: "10m",
      // Thinking must be off. A reasoning model spends the whole 6 s budget in
      // `message.thinking` and returns `message.content` empty, so `explainRun`
      // falls back to the rules on every single question and the eval scores
      // nothing. Measured on qwen3:8b: thinking on = 10.6 s and 0 chars of
      // content; thinking off = 1.7 s and a real answer. Harmless on models
      // that have no thinking mode — Ollama ignores the field.
      think: false,
      // Low temperature: a spoken answer about a real run should not be
      // creative, and a noisy sampler makes a re-run's delta unreadable.
      options: { num_ctx: WINDOW, num_batch: 128, temperature: 0.1, num_predict: 160 },
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const json = await res.json();
  lastMs = Date.now() - started;
  lastTokens = json.prompt_eval_count ?? 0;
  const text = json.message?.content ?? "";
  // Loud, because it is the failure that looks like a bad model but is not:
  // the answer went to the reasoning channel and the caller will see nothing.
  if (!text.trim() && json.message?.thinking) lastThought = true;
  return text;
}

/* ── Run ───────────────────────────────────────────────────────────────────── */

const selected = CASES.filter((c) => !ONLY || c.name.includes(ONLY));
console.log(`model ${MODEL} · window ${WINDOW} · ${RUNS} run(s) a case · ${selected.length} case(s)\n`);

let passes = 0;
let total = 0;
let fellBack = 0;
const rows = [];

for (const c of selected) {
  const results = [];
  for (let i = 0; i < RUNS; i += 1) {
    let text = "";
    let source = "rules";
    let ms = 0;
    let tokens = 0;
    try {
      const got = await explainRun(c.question, c.run, { complete, now: () => NOW });
      text = got.text;
      source = got.source;
      ms = lastMs;
      tokens = lastTokens;
    } catch (err) {
      text = "";
      source = "error";
      results.push({ text, source, ms, tokens, why: `threw: ${err.message}` });
      total += 1;
      continue;
    }
    if (source !== "model") fellBack += 1;
    const why = shared(text, source, c.run) ?? c.expect(text);
    results.push({
      text,
      source,
      ms,
      tokens,
      why: why ? `${why} — said: ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 110))}` : null,
    });
    total += 1;
    if (!why) passes += 1;
  }
  const ok = results.filter((r) => !r.why).length;
  const ms = Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length);
  const tokens = results[0].tokens;
  rows.push({ name: c.name, ok, runs: RUNS, promptTokens: tokens, ms });
  const mark = ok === RUNS ? "✔" : ok === 0 ? "✖" : "◐";
  console.log(`${mark} ${c.name.padEnd(26)} ${ok}/${RUNS}   prompt ${String(tokens).padStart(5)} tok   ${String(ms).padStart(6)} ms`);
  for (const r of results.filter((r) => r.why)) console.log(`    ↳ ${r.why}`);
}

const score = total ? passes / total : 0;
console.log(`\nscore ${passes}/${total} = ${(score * 100).toFixed(0)}%`);
if (fellBack) console.log(`${fellBack}/${total} answer(s) came from the rules fallback, not the model`);
if (lastThought) console.log(`the model answered into its reasoning channel and left content empty — rerun with think:false`);
console.log(JSON.stringify({ model: MODEL, window: WINDOW, runs: RUNS, passes, total, score, fellBack, cases: rows }));
if (GATE && score < GATE) process.exit(1);
