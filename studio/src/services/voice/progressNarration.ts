/**
 * Progress narration — the voice layer's running commentary on an agent run.
 *
 * A coding agent's raw output is tool calls and diffs; nobody wants that read
 * aloud. What a colleague at the next desk would say is one short line when
 * something notable starts — "running the tests now", "editing the composer"
 * — and a one-breath answer when asked how it is going. These helpers turn
 * the run's tool-call stream into those lines. They are pure so the wording
 * can be tested without a microphone.
 */

import type { MachineActionKind } from "./machineAction.ts";

export interface NarratableToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
}

export interface RunProgress {
  startedAt: number;
  /** "frontier" | "claude" | "codex" — only used for wording. */
  engine: string;
  toolCalls: NarratableToolCall[];
  /** The assistant's streamed prose so far, markdown allowed. */
  lastText: string;
  finishedAt?: number;
  /**
   * What `machineAction` classified the turn as, when it came from the voice.
   * Only `inspect` changes anything here, and it has to: an inspect turn is a
   * *question*, and a question whose run says nothing back was being answered
   * "Done." — a completion report standing where an answer belongs.
   */
  kind?: MachineActionKind;
}

const PATH_KEYS = ["file_path", "filePath", "path", "file", "target", "filename", "notebook_path", "directory", "dir"];
const PATTERN_KEYS = ["pattern", "query", "regex", "search", "term", "q"];
const COMMAND_KEYS = ["command", "cmd", "script", "shell"];

function pick(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

/** Say a filename so a synthesiser does not spell it: "Composer dot tsx". */
export function speakablePath(path: string): string {
  const name = basename(path);
  return name.replace(/\./g, " dot ").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function describeCommand(command: string): string {
  const lower = command.toLowerCase();
  if (/\b(vitest|jest|mocha|pytest|node --test|npm test|npm run test|pnpm test|yarn test|cargo test|go test)\b/.test(lower) || /\btest\b/.test(lower)) {
    return "Running the tests";
  }
  if (/\b(tsc|typecheck|type-check|mypy|pyright)\b/.test(lower)) return "Type-checking";
  if (/\b(eslint|lint|prettier|ruff|black|clippy)\b/.test(lower)) return "Linting";
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/.test(lower) || /\b(pip|poetry|cargo)\s+(install|add)\b/.test(lower)) {
    return "Installing dependencies";
  }
  if (/\b(npm|pnpm|yarn|bun)\s+run\s+build\b/.test(lower) || /\b(vite build|next build|tsc -b|cargo build|go build|make)\b/.test(lower)) {
    return "Running the build";
  }
  if (/\bgit\s+(commit)\b/.test(lower)) return "Committing";
  if (/\bgit\s+(push)\b/.test(lower)) return "Pushing to the remote";
  if (/\bgit\s+(status|diff|log|show)\b/.test(lower)) return "Checking git";
  if (/\bgit\s+(checkout|switch|branch)\b/.test(lower)) return "Switching branches";
  if (/\b(vercel|netlify|wrangler|fly|railway|gcloud|aws)\s+(deploy|publish)\b/.test(lower) || /\bdeploy\b/.test(lower)) {
    return "Deploying";
  }
  if (/\b(curl|wget|http)\b/.test(lower)) return "Calling an endpoint";
  if (/\b(ls|find|tree|rg|grep|ag)\b/.test(lower)) return "Looking around the project";
  if (/\b(cat|head|tail|sed -n|less)\b/.test(lower)) return "Reading a file";
  if (/\b(npm|pnpm|yarn|bun)\s+(run|start|dev)\b/.test(lower)) return "Starting a script";
  return "Running a command";
}

/**
 * One short present-tense line for a tool call, or null when it is not worth
 * saying out loud (a completed read, a tiny helper).
 *
 * Only `running` calls narrate, except for tests and builds, whose outcome is
 * the thing the operator is actually waiting to hear.
 */
export function describeToolCall(call: NarratableToolCall): string | null {
  const name = call.name.toLowerCase();
  const args = call.arguments ?? {};
  const path = pick(args, PATH_KEYS);
  const command = pick(args, COMMAND_KEYS);

  if (call.status !== "running") {
    if (command && call.status === "completed") {
      const what = describeCommand(command);
      if (what === "Running the tests" || what === "Running the build" || what === "Type-checking") {
        const output = (call.result ?? "").toLowerCase();
        const failed = /\b(fail(ed|ing|ures?)?|error(s)?)\b/.test(output) && !/\b(0 fail|fail 0|failures: 0|0 errors?)\b/.test(output);
        const noun = what === "Running the tests" ? "Tests" : what === "Type-checking" ? "Type check" : "Build";
        return failed ? `${noun} failed — looking at that.` : `${noun} passed.`;
      }
    }
    if (call.status === "error") return "That step failed — trying another way.";
    return null;
  }

  if (/(^|_)(read|view|cat|open)(_|$)|readfile|read_file|notebookread/.test(name)) {
    return path ? `Reading ${speakablePath(path)}.` : "Reading a file.";
  }
  if (/(^|_)(write|create)(_|$)|writefile|write_file/.test(name)) {
    return path ? `Writing ${speakablePath(path)}.` : "Writing a file.";
  }
  if (/(^|_)(edit|patch|replace|update|apply|multiedit)(_|$)|str_replace|apply_patch|notebookedit/.test(name)) {
    return path ? `Editing ${speakablePath(path)}.` : "Making an edit.";
  }
  if (/(^|_)(grep|search|glob|find|rg|ripgrep)(_|$)/.test(name)) {
    const pattern = pick(args, PATTERN_KEYS);
    return pattern ? `Searching for ${pattern.slice(0, 40)}.` : "Searching the project.";
  }
  if (/(^|_)(ls|list|tree)(_|$)|list_dir|listdir/.test(name)) {
    return path ? `Looking in ${speakablePath(path)}.` : "Looking around the project.";
  }
  if (/(^|_)(bash|shell|exec|execute|run|command|terminal|process)(_|$)/.test(name) || command) {
    return `${describeCommand(command ?? "")}.`;
  }
  if (/(^|_)(web|fetch|browse|http|url)(_|$)|webfetch|websearch/.test(name)) {
    return "Checking something on the web.";
  }
  if (/(^|_)(task|agent|subagent|delegate|spawn)(_|$)/.test(name)) {
    return "Handing part of this to a helper.";
  }
  if (/(^|_)(todo|plan)(_|$)/.test(name)) return "Updating the plan.";
  /*
    The player, said the way a person would say it.

    The generic fallback below would read "Using player dot seek by", which is
    the interface describing itself instead of narrating. These are the only
    tool calls the operator can *see* the result of, so the words have to match
    what the pane is visibly doing.
  */
  if (/^player[._]/.test(name)) {
    switch (name.split(/[._]/)[1]) {
      case "status": return "Checking what the player is showing.";
      case "play": return "Playing it.";
      case "pause": return "Pausing it.";
      case "toggle": return "Toggling playback.";
      case "restart": return "Starting it over.";
      case "seek": case "seek_by": case "seekby": return "Skipping to another point.";
      case "volume": return "Changing the volume.";
      case "mute": return "Muting it.";
      case "unmute": return "Unmuting it.";
      case "rate": return "Changing the speed.";
      case "subtitles": return "Changing the subtitles.";
      case "fullscreen": return "Going fullscreen.";
      case "next": return "Moving to the next one.";
      case "previous": return "Going back one.";
      case "episode": return "Starting that episode.";
      case "episodes": return "Opening the episode list.";
      default: return "Working the player.";
    }
  }
  return `Using ${name.replace(/[_-]+/g, " ")}.`;
}

/**
 * A fenced block whose whole body is one short line is a value wearing a
 * fence — the answer to "what is the port", not a listing. Anything longer is
 * output, and output read aloud is unbearable, so it still goes.
 */
const FENCE_VALUE_CHARS = 40;

function unfence(block: string): string {
  const body = block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "").trim();
  return !body.includes("\n") && body.length <= FENCE_VALUE_CHARS ? ` ${body} ` : " ";
}

/**
 * The first thing the assistant said, made speakable.
 *
 * Code spans are **unwrapped, not deleted**. Deleting them is right for a work
 * narration — "backtick npm run build backtick" is not a sentence — but this
 * same function supplies `summariseOutcome`, which is the whole of what an
 * `inspect` turn ever says back. There the span is the payload: measured
 * 2026-09-10, all eight realistic answers to a state question lost theirs.
 * "The port is `8080`." was spoken as "The port is ."; "There are `3` errors
 * in the log." became "There are errors in the log." — a fluent sentence with
 * the answer removed, which is worse than silence. Keep what was inside the
 * backticks; lose only the backticks.
 */
function firstSentence(text: string, max = 160): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, unfence)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[#*_>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  const match = clean.match(/^[^.!?]+[.!?]/);
  const sentence = (match ? match[0] : clean).trim();
  return sentence.length > max ? `${sentence.slice(0, max - 1).trim()}…` : sentence;
}

function elapsedPhrase(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return `${Math.max(5, Math.round(seconds / 5) * 5)} seconds in`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? "about a minute in" : `about ${minutes} minutes in`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A one-breath answer to "how's it going?" while a run is in flight, built
 * from the tool calls seen so far. Never longer than three short sentences.
 */
export function summariseProgress(run: RunProgress, now = Date.now()): string {
  const calls = run.toolCalls;
  const reads = new Set<string>();
  const edits = new Set<string>();
  let commands = 0;
  let searches = 0;
  for (const call of calls) {
    const name = call.name.toLowerCase();
    const path = pick(call.arguments ?? {}, PATH_KEYS);
    if (/(read|view|cat|open)/.test(name)) {
      if (path) reads.add(basename(path));
    } else if (/(edit|write|patch|replace|create|apply|multiedit|str_replace)/.test(name)) {
      if (path) edits.add(basename(path));
    } else if (/(bash|shell|exec|run|command|terminal)/.test(name) || pick(call.arguments ?? {}, COMMAND_KEYS)) {
      commands += 1;
    } else if (/(grep|search|glob|find)/.test(name)) {
      searches += 1;
    }
  }

  const parts: string[] = [];
  parts.push(`${elapsedPhrase(now - run.startedAt)}.`);

  const done: string[] = [];
  if (reads.size > 0) done.push(`read ${plural(reads.size, "file")}`);
  if (searches > 0) done.push(`searched the project${searches > 1 ? ` ${searches} times` : ""}`);
  if (edits.size > 0) {
    const named = [...edits].slice(0, 2).map(speakablePath).join(" and ");
    done.push(`edited ${edits.size <= 2 ? named : `${plural(edits.size, "file")}, including ${named}`}`);
  }
  if (commands > 0) done.push(`run ${plural(commands, "command")}`);

  if (done.length === 0) {
    const note = firstSentence(run.lastText);
    parts.push(note ? `Still thinking it through — the latest note is: ${note}` : "Still thinking it through; nothing has been changed yet.");
    return parts.join(" ");
  }

  parts.push(`So far it has ${done.length === 1 ? done[0] : `${done.slice(0, -1).join(", ")} and ${done[done.length - 1]}`}.`);

  const running = [...calls].reverse().find((call) => call.status === "running");
  const current = running ? describeToolCall(running) : null;
  if (current) {
    parts.push(`Right now: ${current.charAt(0).toLowerCase()}${current.slice(1)}`);
  } else {
    const note = firstSentence(run.lastText, 120);
    if (note) parts.push(`Latest: ${note}`);
  }
  return parts.join(" ");
}

/**
 * What an inspect turn says when its run finished having said nothing.
 *
 * "Done." is the answer to "do this"; to "did the tests pass" it reports the
 * completion of work in place of the answer that was asked for, which is the
 * fiction `machineAction` exists to keep out of her mouth. Admitting the miss
 * costs the operator one sentence; the alternative costs them their trust in
 * every other answer.
 */
export const NO_ANSWER = "I looked, but nothing came back that I can read out.";

/** What to say once a run finishes and nothing else was read out. */
export function summariseOutcome(run: RunProgress): string {
  const edits = new Set<string>();
  for (const call of run.toolCalls) {
    const name = call.name.toLowerCase();
    const path = pick(call.arguments ?? {}, PATH_KEYS);
    if (path && /(edit|write|patch|replace|create|apply|multiedit|str_replace)/.test(name)) edits.add(basename(path));
  }
  const note = firstSentence(run.lastText, 140);
  if (edits.size === 0) return note || (run.kind === "inspect" ? NO_ANSWER : "Done.");
  const named = [...edits].slice(0, 3).map(speakablePath).join(", ");
  return `Done. I changed ${edits.size <= 3 ? named : `${plural(edits.size, "file")}, including ${named}`}.${note ? ` ${note}` : ""}`;
}
