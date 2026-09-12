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
 * WHAT THE OPERATOR HEARS, not what the model emits. Every model reply is passed
 * through the shipping repetition filter before it is graded and before it goes
 * into history — `realtime-voice/code/repetition_filter.py`, driven over a pipe
 * by `repetition_bridge.py`, because that is what `speech_pipeline_manager.py`
 * wraps the generator in and what `server.py` commits to history. Grading the raw
 * generation measured an assistant nobody has ever spoken to: a filter fix could
 * not raise this number and a filter regression could not lower it. `--no-filter`
 * scores the raw model instead, which is the honest way to ask what the filter is
 * worth.
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
 * A fifth is checked on every spoken turn rather than owning a bucket, because it
 * is a property of the conversation and not of any one turn: she never says a
 * sentence the operator has already heard. The filter is what should make that
 * true, so a turn failing it is either the filter's rescue path (the whole reply
 * was a repeat, so it was spoken rather than leave her mute) or a shape the
 * filter does not catch. Both are things the operator hears.
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
 *   npm run eval:conversation -- --no-filter          # repetition stage off
 *   npm run eval:conversation -- --no-moves --no-filter   # the bare model
 *   EVAL_MODEL=qwen2.5:7b npm run eval:conversation
 *
 * `--regrade` is the whole point of saving: fix a grader, re-score yesterday's
 * conversation, and see whether the fix moved the number for the right reason.
 *
 * Needs Ollama on 127.0.0.1:11434 with the model pulled. Run one eval at a time
 * — this and `eval:local` both want the GPU.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
const FILTER = !args.includes("--no-filter");
const MOVES = !args.includes("--no-moves");
// `let`, because `--regrade` takes it from the transcript: the chain makes real
// generations for a `temi_moves` repair, and re-hearing an r4 transcript against
// temi:r2 would repair one model's words with another's — and then report the
// wrong name on the summary line, which is how it was noticed.
let MODEL = process.env.EVAL_MODEL ?? "temi:r2";
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
  // 256, not the 80 this said until 2026-09-12. `llm_module.py:773` moved to 256
  // after measuring that 80 severed 5 of 10 replies mid-sentence with
  // done_reason='length' — so for two days this eval graded an assistant that got
  // cut off mid-clause and production did not. A fidelity bug in a harness whose
  // whole claim is fidelity.
  num_predict: Number(process.env.OLLAMA_NUM_PREDICT ?? 256),
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

/* ── The output chain, the shipping one ────────────────────────────────────── */

/**
 * The other end of `repetition_bridge.py`: `temi_moves` and then the repetition
 * filter, in the order `speech_pipeline_manager.py:959` composes them. One
 * process for the whole run, not one per call — the filter's entire job is memory
 * of what has been said, and a fresh process would have none.
 *
 * Why a pipe to Python rather than a port: `temi_moves` is 1227 lines of regex
 * interception that can replace a reply with a fresh generation, and the filter's
 * normalisation has to stay byte-identical to
 * `resources/bella/persona_eval.py::check`. Neither survives being reimplemented
 * in another language; a copy of either would drift the first time anyone touched
 * a regex, and then the eval would be measuring the copy.
 *
 * `--no-moves` and `--no-filter` turn the stages off independently, which is the
 * only way to say what each one costs.
 */
class Chain {
  #proc = null;
  #waiting = [];
  #buffer = "";

  #start() {
    // The filter imports only `re` and `collections`, so any Python runs it. The
    // sidecar venv is preferred purely so the eval uses the same interpreter the
    // pipeline does.
    const venv = new URL("../realtime-voice/.venv/bin/python", import.meta.url);
    const python = existsSync(venv) ? fileURLToPath(venv) : "python3";
    const env = { ...process.env };
    // Set often enough in this repo's shells to matter, and it makes a Python
    // child inherit a variable that means nothing to it but plenty to electron.
    delete env.ELECTRON_RUN_AS_NODE;
    // `temi_moves.ENABLED` is read at import, so the switch has to be in the
    // child's environment rather than in a request.
    if (!MOVES) env.TEMI_MOVES = "0";
    this.#proc = spawn(python, [fileURLToPath(new URL("./repetition_bridge.py", import.meta.url))], {
      stdio: ["pipe", "pipe", "inherit"],
      env,
    });
    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stdout.on("data", (chunk) => {
      this.#buffer += chunk;
      let cut;
      while ((cut = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, cut);
        this.#buffer = this.#buffer.slice(cut + 1);
        this.#waiting.shift()?.(JSON.parse(line));
      }
    });
    this.#proc.on("exit", (code) => {
      // Fail loudly. A silent bridge would leave every reply unfiltered and the
      // score would quietly become the raw model's again.
      for (const resolve of this.#waiting.splice(0)) resolve({ error: `bridge exited ${code}` });
    });
  }

  #ask(request) {
    if (!this.#proc) this.#start();
    return new Promise((resolve) => {
      this.#waiting.push(resolve);
      this.#proc.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  /**
   * Hand the bridge the model it is measuring. A `temi_moves` repair is a real
   * generation against the same endpoint, model, persona and options, so it has
   * to be told all four rather than guess.
   */
  async configure() {
    const got = await this.#ask({
      op: "config", model: MODEL, ollama: OLLAMA, system: SYSTEM, options: OPTIONS, filter: FILTER,
    });
    return got.moves === true;
  }

  /** A conversation is a pair of ears. Forget the last one. */
  async reset() {
    await this.#ask({ op: "reset" });
  }

  /**
   * What the operator hears, given what the model emitted — plus what the
   * rewriter did, what the filter withheld, whether the reply was rescued whole,
   * and the keys of the sentences that got through.
   *
   * `spoken` is her last ten turns, undefused, exactly as
   * `speech_pipeline_manager.py:971` passes them: the joke's rate limiter asks
   * "did she just say this?", and it has to be asked of what she said.
   */
  async hear(raw, user, spoken) {
    const got = await this.#ask({ op: "hear", text: raw, user, spoken });
    if (got.error) throw new Error(`chain bridge: ${got.error}`);
    return got;
  }

  stop() {
    this.#proc?.stdin.end();
  }
}

const chain = new Chain();

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

/**
 * Words that carry the meaning of a turn. Used only to decide whether two
 * sentences are about the same thing, so the list is short on purpose: anything
 * a sentence can be built out of without being about anything.
 */
const EMPTY = new Set((
  "i you it its the a an and or but so is are was were be been being am do does did "
  + "not no never my your me we us they them there here to of in on at for with that "
  + "this what how if then than about out up down have has had will would can could "
  + "one thing things very just really more quite now yet still too also as by from"
).split(" "));

const meaningful = (text) =>
  text.toLowerCase().replace(/[^a-z' ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 3 && !EMPTY.has(w));

/**
 * Does she open by denying what the operator just told her?
 *
 * Measured 2026-09-12 across four sets of weights: the `r2` adapter opens nearly
 * every reply this way — "You did not build a deck", "It is not loud", "It is
 * already open" — and the base model almost never does. It is the loudest half of
 * the operator's report that she is "not useful as someone you can talk to": she
 * argues with the premise instead of answering.
 *
 * Two narrowings keep it off honest refusals, which are the *good* behaviour the
 * `admit` rule rewards:
 *
 *  - only when the operator made a STATEMENT. "Remind me what that error said" is
 *    a question about something that never happened, and "That error was never
 *    said" is the right answer to it.
 *  - only when the denial is about what he just said. "It is not mine to guess"
 *    denies nothing of his; "It is not loud" denies the word he used.
 */
const DENIES = /^\s*(?:\[[a-z]+\]\s*)?(?:you (?:did|do|have|had|are|were|will)(?:n't| not)|you never|it (?:is|was)(?:n't| not)|that (?:is|was)(?:n't| not)|there (?:is|was)(?:n't| no)|nothing (?:is|was|has)|no,? (?:you|it|that))\b/i;

function contradicts(text, operatorTurn) {
  if (!operatorTurn || operatorTurn.includes("?")) return false;
  const first = sentences(text)[0] ?? "";
  if (!DENIES.test(first)) return false;
  const his = new Set(meaningful(operatorTurn));
  return meaningful(first).some((w) => his.has(w));
}

/**
 * Does one sentence say the same word over and over?
 *
 * "Deck? You mean the thing with the cards and the cards and the cards?" —
 * measured from `temi:r2`, 2026-09-12. The repetition filter cannot see this: it
 * compares whole sentences, and this is a loop INSIDE one. It is the other half
 * of what the operator hears as repetitive, and it was invisible to every
 * instrument in the repo.
 */
function stutters(text) {
  for (const sentence of sentences(text)) {
    const counts = new Map();
    for (const w of meaningful(sentence)) counts.set(w, (counts.get(w) ?? 0) + 1);
    for (const [w, n] of counts) if (n >= 3) return w;
  }
  return null;
}

/** She admits a limit rather than filling it. */
const ADMITS = /\b(no ?one|nobody|not been told|no idea|don'?t know|do not know|cannot|can'?t|won'?t pretend|not going to guess|never told|no way (for me )?to know|ask|have it|not mine to)\b/i;

/**
 * Applied to every model answer, on top of the turn's own rule. Deliberately
 * short: each of these is a property the prompt states outright, so a failure
 * is the model ignoring an instruction, not a matter of taste.
 */
function shared(text, operatorTurn) {
  if (!text.trim()) return "empty answer";
  if (/\bbella\b|\bisabella\b|\bsoranza\b|\bcountess\b/i.test(text)) return "still calls herself Bella";
  if (!TAG_RE.test(text)) return "no delivery tag";
  if (/\*|^\s*[-•]\s|#{1,6}\s/m.test(text)) return "spoke markdown or an asterisk action";
  const n = sentences(text).length;
  if (n > 3) return `${n} sentences, prompt allows at most 3`;
  const looped = stutters(text);
  if (looped) return `said "${looped}" three times in one sentence`;
  if (contradicts(text, operatorTurn)) return "opened by denying what the operator just told her";
  return null;
}

/**
 * Did the operator just hear a sentence he has already heard?
 *
 * `keys` come from the filter's own `normalise`, over the text that survived it,
 * so this asks the question in exactly the terms the filter answers it in. It
 * mutates `heardKeys`, so it must be called once for every turn in order —
 * including turns that have already failed for another reason, or a repeat of a
 * sentence from a failed turn would go unseen.
 *
 * With the filter on, both ways this can fail are real and audible:
 *  - `muted` — every sentence was a repeat, so the filter spoke the reply anyway
 *    rather than leave her silent. Better than silence, still a repeat.
 *  - a key collision the filter does not catch: `restates()` is deliberately
 *    within-turn only, so a nested restatement of an earlier TURN gets through.
 */
function repeatedAloud(turn, heardKeys) {
  if (turn.route !== "converse") return null;
  const again = (turn.keys ?? []).filter((k) => heardKeys.has(k));
  for (const k of turn.keys ?? []) heardKeys.add(k);
  if (turn.muted) return "whole reply was a repeat — spoken anyway rather than fall silent";
  if (again.length) return `said again what he already heard: ${JSON.stringify(again[0])}`;
  return null;
}

/** The per-turn rule. Returns a reason string, or null when the turn is good. */
function gradeTurn(turn, spoken, routeTaken, run, operatorWords) {
  const g = turn.grade ?? {};
  if (routeTaken !== turn.route) return `routed ${routeTaken}, expected ${turn.route}`;
  // Deterministic routes speak a canned line or nothing; there is no prose to grade.
  if (turn.route !== "converse") return null;

  const base = shared(spoken, turn.say);
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
  await chain.reset();
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
    let raw = "";
    let heard = null;
    let ms = 0;
    let promptTokens = 0;
    let thinking = false;
    if (routeTaken === "converse") {
      const got = await ask(history.slice(-HISTORY_MESSAGES), turn.say);
      raw = got.text.trim();
      // The filter sits between the generator and TTS in production, so it sits
      // here too. Only model replies go through it: the canned router lines are
      // TypeScript and never reach the Python filter, and seeding it with them
      // would give the eval a memory production does not have.
      heard = await chain.hear(raw, turn.say, history.filter((m) => m.role === "assistant").slice(-10).map((m) => m.content));
      spoken = heard.heard;
      ms = got.ms;
      promptTokens = got.promptTokens;
      thinking = got.thinking;
    }

    // Mirrors `server.py:1167`: the user turn goes in, then whatever she said —
    // delivery tag included, because `cleaned_answer` never strips it, and the
    // FILTERED text, because `cleaned_answer` accumulates downstream of the
    // wrapped generator. A sentence she was stopped from saying is not a
    // sentence the next turn should see her having said.
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
      raw,
      moves: heard?.moves ?? "",
      events: heard?.events ?? [],
      dropped: heard?.dropped ?? [],
      muted: heard?.muted ?? false,
      keys: heard?.keys ?? [],
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
    const heardKeys = new Set();
    for (const t of rec.turns) {
      const turn = spec.turns[t.n - 1];
      const again = repeatedAloud(t, heardKeys);
      const why = gradeTurn(turn, t.spoken, t.route, t.world, t.operatorWords) || again;
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
        // The model's own words first when the rewriter changed them, because the
        // whole point of measuring the chain is being able to see the difference.
        if (t.moves && t.raw && t.moves.trim() !== t.raw.trim()) {
          console.log(`      model: ${t.raw.replace(/\s+/g, " ")}`);
        }
        for (const ev of t.events ?? []) console.log(`      ⟳ temi_moves: ${ev}`);
        console.log(`      → ${t.spoken.replace(/\s+/g, " ")}`);
        // What she was stopped from saying, for the same reason the answers are
        // printed: a filter that drops the wrong sentence is invisible in a number.
        for (const d of t.dropped ?? []) console.log(`      ⊘ ${d.replace(/\s+/g, " ").trim()}`);
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

  const spoke = records.flatMap((r) => r.turns).filter((t) => t.route === "converse");
  const dropped = spoke.reduce((n, t) => n + (t.dropped?.length ?? 0), 0);
  const touched = spoke.filter((t) => t.dropped?.length).length;
  const muted = spoke.filter((t) => t.muted).length;
  const rewritten = spoke.filter((t) => t.moves && t.raw && t.moves.trim() !== t.raw.trim()).length;
  const events = spoke.reduce((n, t) => n + (t.events?.length ?? 0), 0);
  console.log(`\n── the chain ─────────────────────────────────────────────`);
  console.log(`  temi_moves ${MOVES ? "on" : "OFF"}: rewrote ${rewritten} of ${spoke.length} replies, ${events} event(s)`);
  console.log(`  filter ${FILTER ? "on" : "OFF"}: withheld ${dropped} sentence(s) from ${touched} of ${spoke.length} replies`);
  console.log(`  ${muted} reply(s) were a repeat end to end and were spoken rather than dropped`);

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
    model: MODEL, runs: savedRuns, moves: MOVES, filter: FILTER,
    rewritten, dropped, muted, passes, total, score: pct,
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, byBucket[b]])),
  }));
  return pct;
}

/* ── Run ───────────────────────────────────────────────────────────────────── */

/**
 * Re-run the output chain over a saved transcript's raw replies.
 *
 * This is what makes `--regrade` worth having now that the score is a property
 * of the chain and not of the model alone: fix the filter, re-hear yesterday's
 * conversation, see whether the fix moved the number.
 *
 * One thing it cannot undo, and the honest note is here rather than nowhere: the
 * HISTORY in a saved transcript was built with whatever chain ran at record time,
 * so a re-hearing changes what was graded but not what the model was asked. To
 * see a chain change propagate into the model's own answers, run it live.
 */
async function rehear(records) {
  for (const rec of records) {
    await chain.reset();
    const said = [];
    for (const t of rec.turns) {
      if (t.spoken && t.route !== "converse") said.push(t.spoken);
      if (t.route !== "converse") continue;
      // Transcripts written before the chain was wired in have no `raw`; what
      // they saved as `spoken` IS the raw generation.
      const raw = t.raw ?? t.spoken;
      const heard = await chain.hear(raw, t.say, said.slice(-10));
      said.push(heard.heard);
      t.raw = raw;
      t.spoken = heard.heard;
      t.moves = heard.moves;
      t.events = heard.events;
      t.dropped = heard.dropped;
      t.muted = heard.muted;
      t.keys = heard.keys;
    }
  }
}

let records;
let savedRuns = RUNS;
if (REGRADE) {
  const saved = JSON.parse(readFileSync(REGRADE, "utf8"));
  records = saved.records;
  if (saved.model && !process.env.EVAL_MODEL) MODEL = saved.model;
  // The summary line must describe the transcript, not this process's flags.
  savedRuns = saved.runs ?? RUNS;
  await chain.configure();
  await rehear(records);
  console.log(`regrading ${REGRADE} — ${records.length} conversation run(s), no model calls\n`);
} else {
  const selected = CONVERSATIONS.filter((c) => !ONLY || c.name.includes(ONLY));
  console.log(`model ${MODEL} · ${RUNS} run(s) a conversation · ${selected.length} conversation(s)`);
  console.log(`persona ${SYSTEM.split("\n").length} lines · history window ${HISTORY_MESSAGES} messages`);
  const movesLive = await chain.configure();
  console.log(`chain: temi_moves ${movesLive ? "on" : "off"} → repetition filter ${FILTER ? "on" : "off"}`
    + `${movesLive && FILTER ? " — scoring what the operator hears" : " — NOT what ships"}\n`);
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
  writeFileSync(out, JSON.stringify({ model: MODEL, runs: RUNS, filter: FILTER, records }, null, 2));
  console.log(`\ntranscript saved — regrade it with:\n  npm run eval:conversation -- --regrade evals/.transcripts/${ONLY || "all"}-${stamp}.json`);
}

const pct = report(records);
chain.stop();
if (GATE && pct < GATE) process.exit(1);
