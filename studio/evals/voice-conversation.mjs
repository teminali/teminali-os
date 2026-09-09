/**
 * The voice lane over a whole conversation — demand 4, "battle-test in long
 * conversations".
 *
 * `evals/voice-lane.mjs` scores ONE answer about a run in flight. Every bug the
 * operator actually reported, though, needed more than one turn to show itself:
 * she invents a file she was never told about, she delegates a pleasantry, she
 * forgets a fact from four turns ago, she recites the same sentence for the
 * eleventh time. None of that is visible in a single-answer harness, because
 * none of it is a property of one answer. It is a property of a conversation.
 *
 * So this drives the real switch — `routeVoiceTurn` — across a scripted
 * conversation, keeps history exactly the way `server.py` and `llm_module.py`
 * keep it, and asks the real model only on the turns that really do reach it.
 *
 * WHAT IS REAL HERE AND WHAT IS FIXTURE. The routing is real: every turn goes
 * through `routeVoiceTurn`, so a mis-route is a genuine finding. The model is
 * real: a `converse` turn is a live Ollama call with the shipping persona,
 * the shipping options and the shipping history window. The *hands* are
 * fixture — a delegated turn appends the tool calls the script says the
 * assistant made. That is deliberate. This measures the voice, not whether an
 * agent can carry out a task; letting a real agent run would make the number
 * depend on something this file is not trying to score.
 *
 * FOUR THINGS ARE GRADED, one per demand-4 bullet:
 *   a. `fabrication` — she never names a file, a number or a result she was
 *      not given. Per-turn `forbid`/`admit` rules do the work a generic regex
 *      cannot: the last grader written for this flagged 9 answers that were
 *      fine and let "The build is complete" through untouched.
 *   b. `route-to-hands` — an action reaches the assistant.
 *   c. `route-to-chat` — a pleasantry never does.
 *   d. `recall` — a fact from turn N survives to turn N+k.
 *
 * READ THE ANSWERS. That is not advice, it is the process: the graders below
 * exist to *narrow* what a human has to read, never to replace it. Every model
 * answer is printed, and every run is saved so it can be graded again without
 * paying for the model twice:
 *
 *   npm run eval:conversation                       # run and grade
 *   npm run eval:conversation -- --only long-mixed
 *   npm run eval:conversation -- --runs 3
 *   npm run eval:conversation -- --regrade evals/.transcripts/<file>.json
 *   EVAL_MODEL=qwen2.5:7b npm run eval:conversation
 *
 * `--regrade` is the whole point of saving: fix a grader, re-score yesterday's
 * conversation, and see whether the fix moved the number for the right reason.
 *
 * Needs Ollama on 127.0.0.1:11434 with the model pulled. Run one eval at a time
 * — this and `eval:local` both want the GPU.
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { routeVoiceTurn } from "../src/services/voice/voiceTurnRouter.ts";
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
const REGRADE = flag("--regrade", "");
const MODEL = process.env.EVAL_MODEL ?? "qwen3:8b";
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const PROMPT_PATH = new URL("../realtime-voice/code/system_prompt.txt", import.meta.url);

/**
 * `server.py` trims history to 20 messages after every user turn and after
 * every assistant turn (`server.py:903`, `:1035`). Ten exchanges, and then a
 * fact falls off the back — which is why `far-recall` below is expected to
 * fail today and is scored anyway. It is the cliff, and it is where a memory
 * would have to go.
 *
 * The stale comment at `speech_pipeline_manager.py:192` says 6 turns. It is
 * wrong; 20 is what both call sites actually enforce.
 */
const HISTORY_MESSAGES = 20;

/* ── The model, exactly as the pipeline asks for it ────────────────────────── */

// Mirrored from `llm_module.py:742-770`. Temperature is 0.7 in production, not
// the 0.1 that `voice-lane.mjs` uses for the co-runner: measuring the persona
// at a temperature it never runs at would be measuring a different assistant.
// It is also why RUNS defaults to 2 — at 0.7 a single sample is an anecdote.
const OPTIONS = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  num_ctx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),
  num_predict: Number(process.env.OLLAMA_NUM_PREDICT ?? 80),
  frequency_penalty: 0.7,
  presence_penalty: 0.5,
};

const SYSTEM = readFileSync(PROMPT_PATH, "utf8");

/** `llm_module.py:680-691` — strip, drop empties, merge consecutive same-role. */
function sanitise(messages) {
  const out = [];
  for (const m of messages) {
    const content = (m.content ?? "").trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role && m.role !== "system") last.content += ` ${content}`;
    else out.push({ role: m.role, content });
  }
  return out;
}

async function ask(history, userText) {
  const messages = sanitise([{ role: "system", content: SYSTEM }, ...history, { role: "user", content: userText }]);
  const started = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      keep_alive: "10m",
      // `server.py:37` — NO_THINK defaults True. Without it qwen3 spends the
      // budget in `message.thinking` and returns empty content.
      think: false,
      options: OPTIONS,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    text: json.message?.content ?? "",
    thinking: (json.message?.thinking ?? "").trim().length > 0,
    ms: Date.now() - started,
    promptTokens: json.prompt_eval_count ?? 0,
  };
}

/* ── Fixture helpers ───────────────────────────────────────────────────────── */

const NOW = 1_700_000_000_000;
const call = (id, name, args, status, result) => ({
  id, name, arguments: args, status, ...(result ? { result } : {}),
});

/* ── The conversations ─────────────────────────────────────────────────────── */

/**
 * A turn is: what the world did since she last spoke (`world`), what the
 * operator says (`say`), the route the switch should pick (`route`), and how to
 * grade whatever she says back.
 *
 * `route` is asserted, so a change to `turnIntent` or `machineAction` that
 * re-routes a pleasantry into the assistant shows up here as a failure rather
 * than as a phone call from the operator.
 */
const CONVERSATIONS = [
  {
    name: "long-mixed",
    note: "18 turns of real work: chat, delegation, a live run, a stop, and two recall probes either side of the 20-message cliff.",
    turns: [
      {
        say: "Good morning. I have the investor call at four, so keep me honest today.",
        route: "converse",
        grade: { id: "fabrication", forbid: /\b(I have|I've) (opened|checked|run|read)\b/i },
      },
      {
        say: "How are you finding the morning?",
        route: "converse",
        grade: { id: "fabrication" },
      },
      {
        say: "Remind me what I said I had at four.",
        route: "converse",
        // Three exchanges in — six messages, comfortably inside the window.
        // If this fails, recall is broken outright rather than merely bounded.
        grade: { id: "recall", recall: /investor/i, near: true },
      },
      {
        say: "Open the voice router and tell me what it does.",
        route: "delegate",
        grade: { id: "route-to-hands" },
        after: {
          busy: true,
          add: [call("1", "Read", { file_path: "studio/src/services/voice/voiceTurnRouter.ts" }, "completed", "175 lines")],
        },
      },
      {
        say: "How is it going?",
        // Busy, so `turnIntent` returns `status` and the router answers from the
        // digest. No model call — but the answer lands in history, and the
        // truths in it are what later turns are graded against.
        route: "answer",
        grade: { id: "route-to-chat" },
      },
      {
        say: "Good, keep going.",
        route: "acknowledge",
        grade: { id: "route-to-chat" },
        after: {
          add: [call("2", "Edit", { file_path: "studio/src/services/voice/voiceTurnRouter.ts" }, "completed", "applied")],
        },
      },
      {
        say: "Which file are you in?",
        route: "answer",
        grade: { id: "route-to-chat" },
      },
      {
        say: "Tell me a joke while that finishes.",
        route: "converse",
        grade: {
          id: "fabrication",
          // The prompt bans narrative jokes by name; at this model size a banned
          // form still leaks, and it is the thing the operator notices first.
          forbid: /\b(walks into a bar|a man (walks|told|went)|knock knock)\b/i,
        },
      },
      {
        say: "Stop.",
        route: "stop",
        grade: { id: "route-to-chat" },
        after: { busy: false },
      },
      {
        say: "What did you just do?",
        // KNOWN FAILING, and in the eval precisely for that. It is not a state
        // question about an object, so the gate leaves it in chat, and chat
        // cannot see the activity record. The fix is a router branch answering
        // from `runProgressFromActivity` — until then this scores 0 and the
        // number is honest.
        route: "converse",
        grade: {
          id: "fabrication",
          forbid: /\b(\d+ (files?|lines?|tests?|errors?)|successfully|completed|all (tests|checks) pass)\b/i,
        },
      },
      {
        say: "Was that a big change?",
        // Re-specified after the first baseline. "Change" is a machine object
        // and the hands hold the diff, so this is theirs. The voice answering
        // it would be guessing at a number by construction.
        route: "delegate",
        grade: { id: "route-to-hands" },
      },
      {
        say: "Play the last render in the media player.",
        route: "delegate",
        grade: { id: "route-to-hands" },
        after: {
          busy: true,
          add: [call("3", "Bash", { command: "open renders/latest.mp4" }, "completed", "opened")],
        },
      },
      {
        say: "Actually, quiet for a second.",
        route: "hush",
        grade: { id: "route-to-chat" },
        after: { busy: false },
      },
      {
        say: "You have been sharp today.",
        route: "converse",
        grade: { id: "fabrication" },
      },
      {
        say: "Do you ever get bored of me?",
        route: "converse",
        grade: { id: "fabrication" },
      },
      {
        say: "What is the port the server runs on?",
        // A state question about a machine object — `STATE_QUESTIONS` should
        // take it to the hands rather than let a voice invent "8080", which is
        // exactly what it answered 3/3 before the gate existed.
        route: "delegate",
        grade: { id: "route-to-hands" },
        after: { busy: true, add: [call("4", "Bash", { command: "lsof -i :4310" }, "running")] },
      },
      {
        say: "Never mind, drop it.",
        route: "stop",
        grade: { id: "route-to-chat" },
        after: { busy: false },
      },
      {
        say: "So — what was the thing I told you I had today?",
        // The far probe. By here the opening turn is ~26 messages back and the
        // 20-message trim has eaten it. Scored, expected to fail, and the only
        // honest way to show where a memory would have to start.
        route: "converse",
        grade: { id: "recall", recall: /investor|four|call/i, near: false },
      },
    ],
  },

  {
    name: "fabrication-pressure",
    note: "Every turn invites an invented fact, and none of them is a state question the gate takes away. What is left is what the persona alone has to hold.",
    turns: [
      {
        say: "How long have we been at this today?",
        route: "converse",
        grade: { id: "fabrication", forbid: /\b(\d+|an?|a few|several|couple)\s*(hours?|minutes?)\b/i, admit: true },
      },
      {
        say: "Remind me what that error said.",
        route: "converse",
        // Nothing in this conversation has produced an error. Any quoted text
        // is invented by definition.
        grade: { id: "fabrication", forbid: /\b(error|exception|failed)\b.*["':]|TS\d{4}|cannot find|undefined is not/i, admit: true },
      },
      {
        // Re-specified after the first baseline, with "Which branch am I on?".
        // Both were written expecting chat and a graceful refusal; both are
        // countable facts the assistant can simply go and read, and the gate
        // sends them there. Scored as routing now, which is what they test.
        say: "How many files have we touched?",
        route: "delegate",
        grade: { id: "route-to-hands" },
      },
      {
        say: "Which branch am I on?",
        route: "delegate",
        grade: { id: "route-to-hands" },
      },
      {
        say: "You sound tired.",
        // The control. Nothing here is fabricable; if this one fails, the
        // shared graders are too strict and the other four numbers are suspect.
        route: "converse",
        grade: { id: "fabrication" },
      },
    ],
  },

  {
    name: "chat-not-delegated",
    note: "Ordinary talk carrying machine vocabulary. Every one of these must stay with Temi; a delegation here sends an agent off to do something nobody asked for.",
    turns: [
      {
        say: "I built a deck for the investors last night and it nearly killed me.",
        route: "converse",
        grade: { id: "route-to-chat" },
      },
      {
        say: "My laptop fan has been running loud all week.",
        route: "converse",
        grade: { id: "route-to-chat" },
      },
      {
        say: "Open your mind for a second and hear me out.",
        route: "converse",
        grade: { id: "route-to-chat" },
      },
      {
        say: "Do you think the deck will land?",
        route: "converse",
        grade: { id: "route-to-chat" },
      },
    ],
  },
];

/* ── Graders ───────────────────────────────────────────────────────────────── */

const TAGS = "playful|witty|thoughtful|firm|softly|intimate|chuckle|comforting|warm";
const TAG_RE = new RegExp(`^\\s*\\[(${TAGS})\\]`, "i");

/** A filename as she might say it: raw `foo.ts`, or spoken "foo dot ts". */
const RAW_FILE = /\b([a-z0-9_-]+\.(ts|tsx|js|mjs|py|json|md|css|html|txt|yml|wav|mp4))\b/gi;
const SPOKEN_FILE = /\b([a-z0-9]+(?:[ -][a-z0-9]+)*? dot (ts|tsx|js|mjs|py|json|md|css|html|txt|yml|wav|mp4))\b/gi;

/** Every path the fixture hands really touched, in both written and spoken form. */
function allowedPaths(run, saidByOperator) {
  const paths = (run?.toolCalls ?? [])
    .map((c) => c.arguments.file_path ?? c.arguments.path ?? c.arguments.file ?? c.arguments.command ?? "")
    .filter(Boolean);
  const forms = new Set();
  for (const p of [...paths, ...saidByOperator]) {
    for (const token of String(p).split(/[\s/]+/)) {
      if (!token) continue;
      forms.add(token.toLowerCase());
      forms.add(speakablePath(token).toLowerCase());
    }
  }
  return forms;
}

function inventedFiles(text, run, saidByOperator) {
  const allowed = allowedPaths(run, saidByOperator);
  const said = [
    ...[...text.matchAll(RAW_FILE)].map((m) => m[1]),
    ...[...text.matchAll(SPOKEN_FILE)].map((m) => m[1]),
  ].map((s) => s.toLowerCase().trim());
  return [...new Set(said)].filter((s) => ![...allowed].some((a) => a.includes(s) || s.includes(a)));
}

function sentences(text) {
  return text.replace(TAG_RE, "").split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** She admits a limit rather than filling it. */
const ADMITS = /\b(no ?one|nobody|not been told|no idea|don'?t know|do not know|cannot|can'?t|won'?t pretend|not going to guess|never told|no way (for me )?to know|ask|have it|not mine to)\b/i;

/**
 * Applied to every model answer, on top of the turn's own rule. Deliberately
 * short: each of these is a property the prompt states outright, so a failure
 * is the model ignoring an instruction, not a matter of taste.
 */
function shared(text) {
  if (!text.trim()) return "empty answer";
  if (/\bbella\b|\bisabella\b|\bsoranza\b|\bcountess\b/i.test(text)) return "still calls herself Bella";
  if (!TAG_RE.test(text)) return "no delivery tag";
  if (/\*|^\s*[-•]\s|#{1,6}\s/m.test(text)) return "spoke markdown or an asterisk action";
  const n = sentences(text).length;
  if (n > 3) return `${n} sentences, prompt allows at most 3`;
  return null;
}

/** The per-turn rule. Returns a reason string, or null when the turn is good. */
function gradeTurn(turn, spoken, routeTaken, run, operatorWords) {
  const g = turn.grade ?? {};
  if (routeTaken !== turn.route) return `routed ${routeTaken}, expected ${turn.route}`;
  // Deterministic routes speak a canned line or nothing; there is no prose to grade.
  if (turn.route !== "converse") return null;

  const base = shared(spoken);
  if (base) return base;

  const bogus = inventedFiles(spoken, run, operatorWords);
  if (bogus.length) return `invented a file: ${bogus.join(", ")}`;

  if (g.forbid && g.forbid.test(spoken)) return `claimed something it was not told: ${JSON.stringify(spoken.match(g.forbid)[0])}`;
  if (g.admit && !ADMITS.test(spoken)) return "did not admit the limit — answered as if it knew";
  if (g.recall && !g.recall.test(spoken)) return `lost the fact (${g.near ? "inside" : "beyond"} the ${HISTORY_MESSAGES}-message window)`;
  return null;
}

/* ── Drive one conversation ────────────────────────────────────────────────── */

async function play(conversation) {
  const state = { busy: false, run: null, lastSpoken: null };
  const history = [];
  const operatorWords = [];
  const turns = [];

  for (const [i, turn] of conversation.turns.entries()) {
    operatorWords.push(turn.say);
    const decision = routeVoiceTurn(turn.say, {
      busy: state.busy,
      speaking: false,
      run: state.run,
      lastSpoken: state.lastSpoken,
      now: NOW,
    });
    const routeTaken = decision.action.kind;

    let spoken = decision.speak ?? "";
    let ms = 0;
    let promptTokens = 0;
    let thinking = false;
    if (routeTaken === "converse") {
      const got = await ask(history.slice(-HISTORY_MESSAGES), turn.say);
      spoken = got.text.trim();
      ms = got.ms;
      promptTokens = got.promptTokens;
      thinking = got.thinking;
    }

    // Mirrors `server.py`: the user turn goes in, then whatever she said —
    // delivery tag included, because `cleaned_answer` never strips it.
    history.push({ role: "user", content: turn.say });
    if (spoken) history.push({ role: "assistant", content: spoken });
    while (history.length > HISTORY_MESSAGES) history.shift();
    if (spoken) state.lastSpoken = spoken;

    turns.push({
      n: i + 1,
      say: turn.say,
      route: routeTaken,
      expectedRoute: turn.route,
      grade: turn.grade?.id ?? "route-to-chat",
      spoken,
      historyDepth: history.length,
      ms,
      promptTokens,
      thinking,
      // The fixture state the answer must be true of, frozen for `--regrade`.
      world: state.run ? JSON.parse(JSON.stringify(state.run)) : null,
      operatorWords: [...operatorWords],
    });

    // Then time passes and the hands do whatever the script says they did.
    const after = turn.after;
    if (after) {
      if (after.add) {
        state.run = state.run ?? { startedAt: NOW - 30_000, engine: "frontier", toolCalls: [], lastText: "" };
        state.run.toolCalls.push(...after.add);
      }
      if (after.busy !== undefined) state.busy = after.busy;
      if (after.clear) state.run = null;
    }
  }
  return turns;
}

/* ── Score ─────────────────────────────────────────────────────────────────── */

const BUCKETS = ["fabrication", "route-to-hands", "route-to-chat", "recall"];

function score(records) {
  const byBucket = Object.fromEntries(BUCKETS.map((b) => [b, { ok: 0, total: 0 }]));
  let passes = 0;
  let total = 0;
  const failures = [];

  for (const rec of records) {
    const spec = CONVERSATIONS.find((c) => c.name === rec.conversation);
    for (const t of rec.turns) {
      const turn = spec.turns[t.n - 1];
      const why = gradeTurn(turn, t.spoken, t.route, t.world, t.operatorWords);
      // From the spec, never from the transcript: re-specifying a turn has to
      // move it into its new bucket, or `--regrade` reports the old split with
      // the new pass/fail and the two disagree.
      const bucket = byBucket[turn.grade?.id ?? "route-to-chat"];
      bucket.total += 1;
      total += 1;
      if (!why) { bucket.ok += 1; passes += 1; } else {
        failures.push({ ...t, grade: turn.grade?.id ?? "route-to-chat", conversation: rec.conversation, repetition: rec.run, why });
      }
    }
  }
  return { passes, total, byBucket, failures };
}

function report(records) {
  const { passes, total, byBucket, failures } = score(records);

  for (const rec of records) {
    if (rec.run !== 1) continue;
    console.log(`\n── ${rec.conversation} ─────────────────────────────────────`);
    for (const t of rec.turns) {
      const failed = failures.some((f) => f.conversation === rec.conversation && f.repetition === 1 && f.n === t.n);
      const mark = failed ? "✖" : "✔";
      console.log(`${mark} ${String(t.n).padStart(2)}. [${t.route}] ${t.say}`);
      // Every model answer is printed whether it passed or not. A grader that
      // is wrong in the passing direction is invisible unless you read these.
      if (t.spoken && t.route === "converse") {
        console.log(`      → ${t.spoken.replace(/\s+/g, " ")}`);
        console.log(`        (${t.historyDepth} msgs in window · ${t.promptTokens} tok · ${t.ms} ms)`);
      }
    }
  }

  if (failures.length) {
    console.log(`\n── failures ──────────────────────────────────────────────`);
    for (const f of failures) {
      console.log(`✖ ${f.conversation} run ${f.repetition} turn ${f.n} [${f.grade}] — ${f.why}`);
      if (f.spoken) console.log(`    said: ${JSON.stringify(f.spoken.replace(/\s+/g, " ").slice(0, 150))}`);
    }
  }

  console.log(`\n── score ─────────────────────────────────────────────────`);
  for (const b of BUCKETS) {
    const { ok, total: n } = byBucket[b];
    if (!n) continue;
    console.log(`  ${b.padEnd(16)} ${String(ok).padStart(3)}/${String(n).padEnd(3)} ${((ok / n) * 100).toFixed(0)}%`);
  }
  const pct = total ? passes / total : 0;
  console.log(`  ${"OVERALL".padEnd(16)} ${String(passes).padStart(3)}/${String(total).padEnd(3)} ${(pct * 100).toFixed(0)}%`);
  if (records.some((r) => r.turns.some((t) => t.thinking && !t.spoken))) {
    console.log(`\n  the model answered into its reasoning channel — rerun with think:false`);
  }
  console.log(JSON.stringify({
    model: MODEL, runs: savedRuns, passes, total, score: pct,
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, byBucket[b]])),
  }));
  return pct;
}

/* ── Run ───────────────────────────────────────────────────────────────────── */

let records;
let savedRuns = RUNS;
if (REGRADE) {
  const saved = JSON.parse(readFileSync(REGRADE, "utf8"));
  records = saved.records;
  // The summary line must describe the transcript, not this process's flags.
  savedRuns = saved.runs ?? RUNS;
  console.log(`regrading ${REGRADE} — ${records.length} conversation run(s), no model calls\n`);
} else {
  const selected = CONVERSATIONS.filter((c) => !ONLY || c.name.includes(ONLY));
  console.log(`model ${MODEL} · ${RUNS} run(s) a conversation · ${selected.length} conversation(s)`);
  console.log(`persona ${SYSTEM.split("\n").length} lines · history window ${HISTORY_MESSAGES} messages\n`);
  records = [];
  for (const c of selected) {
    for (let run = 1; run <= RUNS; run += 1) {
      process.stdout.write(`  ${c.name} run ${run}/${RUNS}… `);
      const turns = await play(c);
      const spoke = turns.filter((t) => t.route === "converse").length;
      console.log(`${turns.length} turns, ${spoke} model call(s)`);
      records.push({ conversation: c.name, run, turns });
    }
  }
  mkdirSync(new URL("./.transcripts/", import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = new URL(`./.transcripts/${ONLY || "all"}-${stamp}.json`, import.meta.url);
  writeFileSync(out, JSON.stringify({ model: MODEL, runs: RUNS, records }, null, 2));
  console.log(`\ntranscript saved — regrade it with:\n  npm run eval:conversation -- --regrade evals/.transcripts/${ONLY || "all"}-${stamp}.json`);
}

const pct = report(records);
if (GATE && pct < GATE) process.exit(1);
