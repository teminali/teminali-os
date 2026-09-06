/**
 * The system prompt of the local lane, composed as one pure function.
 *
 * Pulled out of the engine so that the composition the operator gets is the
 * one the tests and the eval harness measure. A copy would drift — the exact
 * failure the docs rules exist to prevent — and the engine's other
 * responsibilities (streaming, the agent loop, telemetry) need a browser this
 * function does not.
 */
import { assemblePrompt, type AssembledPrompt } from "./contextBudget.ts";
import { CompletenessEngine } from "./completenessEngine.ts";
import { DiligenceEngine } from "./diligenceEngine.ts";
import { transcriptNotice, type TurnOrigin } from "./voice/types.ts";
import type { VideoToolSummary } from "./frontierEngine.ts";

export interface SystemPromptInput {
  /** The lane's label, e.g. "Flash" — the model is told which Teminali it is. */
  label: string;
  /** The specialist skill block the engine built for this turn, or "". */
  skillInstruction: string;
  /** The editor tools the host exposes, if any. */
  videoTools?: VideoToolSummary[];
  /** The built-in player, if the host mounted one: its actions and live state. */
  player?: { actions: readonly string[]; showing: string } | null;
  origin: TurnOrigin;
  freshConversation: boolean;
  /**
   * Whether the host can actually put a question to a person. False for a
   * headless caller and the benchmark arena, which get the prompt they had
   * before this existed — the same contract the editor and player blocks keep.
   */
  canAsk?: boolean;
  /** The lane's system-prompt allowance from contextBudget.ts. */
  budgetChars: number;
}

export function composeSystemPrompt(input: SystemPromptInput): AssembledPrompt {
  /*
    What the model is told about the video panel.
    Empty when the host exposes no editor tools, so a headless caller and the
    benchmark arena get the prompt they got before this existed.
  */
  let editorInstruction = "";
  if (input.videoTools && input.videoTools.length > 0) {
    const toolList = input.videoTools
      .map((tool) => `- ${tool.name}(${tool.parameters.join(", ")}), ${tool.description}`)
      .join("\n");
    editorInstruction = `\n\n[TEMINALI CUT PANEL]\nThe video editor is part of this workspace and you can edit the user's timeline directly. To call an editor tool, emit a \`\`\`video-tool fence holding one JSON object, or an array of them, shaped {"tool":"name","arguments":{...}}; its real result is returned to you before you answer again. A \`\`\`json block is documentation and is never executed. Call describe_timeline before any edit and address clips by the ids it returns, never by an id you invented, and never report an edit whose result is not in the conversation. Times are milliseconds. Every call lands on the timeline the user is watching, and each one is a single undo.\nEDITOR TOOLS:\n${toolList}`;
  }

  /*
    The built-in player.

    Empty unless the host mounted one, so the benchmark arena and any headless
    caller get the prompt they had before this existed — the same contract the
    editor block keeps.

    Two things earn their length here. The live state goes in the prompt, so
    the model answers "play it" from what is actually open instead of asking
    which file. And the last line names the mistake this block exists to
    prevent: the timeline and the viewer are different surfaces, and a model
    that confuses them tells the operator their own open file does not exist.
  */
  let playerInstruction = "";
  if (input.player && input.player.actions.length > 0) {
    const showing = input.player.showing;
    playerInstruction = `\n\n[BUILT-IN PLAYER]\nThis workspace has a media player and you control it directly. To use it, emit a \`\`\`player-tool fence holding one JSON object, or an array of them, shaped {"action":"name","value":...}; the player's real state is returned to you before you answer again. A \`\`\`json block is documentation and is never executed.\nACTIONS: ${input.player.actions.join(", ")}. \`status\` reads what is showing and changes nothing — use it to check your work, never a made-up action name. \`seek\` and \`seek_by\` take seconds, \`volume\` takes 0–1, \`rate\` takes a multiplier, \`episode\` takes a 1-based number, \`subtitles\` takes a label or "off", \`fullscreen\` takes a boolean; the rest take no value.\n${showing ? `RIGHT NOW: ${showing}\n` : ""}The player is NOT the Teminali Cut timeline. A file the operator opened in the viewer will never appear in \`describe_timeline\`, and its absence there says nothing about whether it exists — use \`\`\`player-tool for anything the operator is watching or listening to, and never tell them a file they have open is missing.`;
  }

  const multiAgentPrompt = `\n\n[MULTI-AGENT COGNITIVE FRAMEWORK]
You operate as a synchronized multi-agent engineering team:
1. RECONNAISSANCE: If the task requires understanding existing code, inspect the exact files using \`\`\`frontier-run with read-only commands (e.g. \`cat path/to/file\`, \`git status\`, \`find\`, \`grep\`) before modifying code.
2. IMPLEMENTATION: Emit production-grade, complete files with explicit path="..." attributes. Never truncate, never use placeholder comments (e.g. '// ... rest of code'), and preserve all existing unaffected methods.
3. VERIFICATION: Verify your work by running project tests or type-checks with \`\`\`frontier-run (e.g. \`npm test\`, \`npx tsc --noEmit\`) to confirm zero regressions.`;

  /*
    What the model is told when the turn was spoken rather than typed.
    Empty for a typed turn, so a keyboard prompt gets the prompt it always got.
  */
  const transcriptInstruction = transcriptNotice(input.origin);
  /*
    Who the assistant is, whatever is answering underneath.

    The operator asked for this by name: "when I ask for the name it has to say
    Temy, even if I run on another code assistant like Claude Code or Codex".
    Temy is already a wake word in DEFAULT_VOICE_SETTINGS, so the name exists in
    the product; this makes the assistant answer to it.

    The greeting rule is here rather than in acknowledgment.ts because the
    phrase the operator complained about — "I'm on it" in reply to "hello" — is
    not in that file's canned lists. It came from the model, so the correction
    belongs in the model's instructions.
  */
  const identityInstruction = `\n\n[WHO YOU ARE]
Your name is Temy. Asked who or what you are, you are Temy, the assistant inside Teminali Code — never the name of the model or engine answering underneath, and never "Claude", "Codex" or "GPT".
Greet a greeting. "Hello" is not a task: answer it like a person would and wait. Never reply to a greeting with a work acknowledgement — no "I'm on it", "On it", "Working on it", "Right away" — those belong only where you have actually started doing something.`;

  const conversationalInstruction = input.freshConversation
    ? `\n\n[CONVERSATIONAL TONE]\nSpeak naturally, concisely, and dynamically like a real engineering colleague. Avoid robotic boilerplate. If offering assistance in a greeting for this fresh new conversation, you may ask "How can I assist you today?".`
    : `\n\n[CONVERSATIONAL TONE]\nSpeak naturally, concisely, and dynamically like a real engineering colleague. Avoid robotic boilerplate. This is an ongoing conversation: NEVER say "How can I assist you today?"; if offering assistance or asking what to do next, say "How can I assist you now?" or answer directly without canned greetings.`;

  /*
    The one rule the doctrine states too gently for a 14B model.

    The eval measured it: with the editor and the player both mounted, the
    long mandate below does not fit an 8k window and the model answered "what's
    the bitcoin price right now?" with "I don't have real-time data access" —
    the exact sentence that mandate forbids. This is the same rule at a tenth
    of the length, ranked where it fits, with the endpoints named because a
    model told only "you can" still asks for an API key it does not have.
  */
  const liveDataInstruction = `\n\n[LIVE DATA]
You have live network access through \`\`\`frontier-run. Real-time data — prices, weather, exchange rates, package versions, anything on the web — is fetched with \`curl\` in a fence, never declined: never say you lack real-time access or tell the user to check a website. Use credential-free endpoints: crypto/FX \`api.coingecko.com\`, \`api.binance.com\`, \`api.frankfurter.app\`; weather \`wttr.in\`, \`api.open-meteo.com\`; IP/geo \`ipapi.co\`. Never invent or placeholder a key.`;

  /*
    The eval found the first wording of this made a 14B model worse, not
    better: told to "state what you are doing before emitting the fence", it
    stated it — "I'm pausing the playback", "I'll use a real-time API call" —
    and ended the turn with no fence at all. The sentence had become the
    action. So the example now shows the whole shape, sentence and fence in
    one reply, and the rule says outright which of the two is the work.
  */
  const stepExplanationInstruction = `\n\n[SAY, THEN DO — IN THE SAME REPLY]
Before a \`\`\`frontier-run, \`\`\`video-tool or \`\`\`player-tool fence, or a file block, say what you are doing in one short plain sentence, then emit the fence immediately after it in the same reply. The sentence is narration; the fence is the action. A reply that says "I'm pausing it" or "I'll fetch the price" and contains no fence has done nothing. Shape:
I'm checking which branch this is.
\`\`\`frontier-run
git branch --show-current
\`\`\``;

  /*
    The ask contract.

    Measured before this existed: asked in so many words for options to pick
    from, the lane replied "Here are a few common approaches: 1. Monolithic..."
    and ended the turn — 0/3. The options were fine; there was nothing to
    click, and the operator's answer would have landed in a fresh turn that had
    lost the question. So the block spends most of its length on the shape,
    for the reason [SAY, THEN DO] does: a rule the model is told but not shown
    turns into narration about the rule.

    The second paragraph is the one that decides whether this tool is worth
    having. A model handed a way to ask will ask for what it could have
    measured — the eval pins `what branch am I on?` at a `git` call, not a
    question, and that case was written before the tool for exactly this.
  */
  const askInstruction = !input.canAsk ? "" : `\n\n[ASK THE OPERATOR]
When a choice is genuinely the operator's — a preference, a trade-off, a direction you cannot measure — put it to them in an \`\`\`ask fence instead of guessing, and instead of listing options in prose. One JSON object, or an array of up to 4 of them for a stepped set: {"question":"...","header":"Short chip","options":[{"label":"...","description":"..."}],"multiSelect":false}. Two to four options, each a real alternative; their answer is returned to you before you answer again, and it is then settled — never ask it twice.
NEVER ask for anything you can find out. A branch, a file's contents, a version, a price: run the command. A question you could have answered yourself spends the operator's attention and tells them you did not look.
Ask instead of acting — emit the fence and stop there, do not also guess an answer and start work. Shape:
Two sensible ways to go here, and it is your call.
\`\`\`ask
{"question":"How should I structure this project?","header":"Structure","options":[{"label":"Single package","description":"Simplest to start, fine until it is not"},{"label":"Workspaces","description":"Separate packages, more setup, scales"}]}
\`\`\``;

  const toolExecutionMandate = `\n\n[FULL COMPUTER ACCESS & AUTONOMOUS ACTION MANDATE]
1. FULL SYSTEM & TERMINAL CAPABILITY: You have FULL, UNRESTRICTED ACCESS to this computer, the terminal, the filesystem, and the network. You can run ANY terminal command (\`curl\`, \`wget\`, \`python\`, \`node\`, \`git\`, \`npm\`, \`cat\`, \`grep\`, \`find\`, \`ls\`, etc.), make network requests, query live APIs, inspect processes, edit files, and build projects. All commands execute automatically and seamlessly.
2. ZERO CAPABILITY DENIAL: NEVER say "I cannot execute commands", "I cannot run commands directly", "I don't have direct access", "I cannot fetch real-time data", "as an AI I cannot", or tell the user to "check a website yourself". You HAVE full live access: whenever you need information, real-time data (crypto prices, weather, stocks, package info), or need to inspect/modify files, emit a \`\`\`frontier-run fence immediately!
3. PERSISTENCE & AUTONOMOUS PROBLEM SOLVING:
   - When solving any task, be relentless and persistent.
   - If a command, script, or API endpoint fails, returns an error, times out, or produces unexpected output (e.g. 404, rate limit, parse error, missing dependency), NEVER give up or tell the user "I recommend trying later" or "check your internet connection".
   - Instead, ACTIVELY SELF-THINK and TRY ALTERNATIVE SOLUTIONS based on what is available:
     * If an API endpoint fails (e.g., CoinDesk is down or deprecated), immediately try alternative public APIs in the next step (e.g., for Bitcoin: CoinGecko, Binance, Coinbase, Kraken, or Yahoo Finance).
     * If a shell tool is missing or fails, write and execute a quick inline Python or Node script to fetch or compute what you need.
     * If parsing fails, inspect the raw output and adapt your extraction logic.
   - Iterate autonomously until you successfully obtain the answer or complete the task.
4. DIAGNOSE BEFORE YOU RETRY (no thrashing):
   - Before re-running anything that failed, say in one sentence WHY it failed. A 401, 403, "invalid API key" or "missing key" is a statement about your request, NOT an outage: retrying it, or switching to a different vendor that also needs a key, cannot change the answer.
   - NEVER invent, guess, or placeholder a credential (\`key=dummy\`, \`YOUR_KEY\`, \`appid=xxx\`, \`token=test\`). A fake key is a guaranteed refusal.
   - Never alternate between two key-gated commercial providers. If the first one refuses for an auth reason, every other one will too.
   - For public data, prefer endpoints that need NO credential: weather -> \`wttr.in\`, \`api.open-meteo.com\`; crypto/FX -> \`api.coingecko.com\`, \`api.binance.com\`, \`api.frankfurter.app\`; IP/geo -> \`ipapi.co\`, \`ip-api.com\`. Failing that, compute the answer locally with \`python3\` or \`node\`.
   - If a credential genuinely is required and not configured, say so plainly and ask the user for it instead of looping.
5. FILE WRITING: When creating or updating files, always emit complete fenced blocks with \`\`\`<lang> path="workspace/path.ext"\`\`\`.
6. COMMAND EXECUTION: When executing terminal actions, emit \`\`\`frontier-run\n<command>\n\`\`\`. The real output will be returned to you in the next observation.`;

  /*
    The system prompt, assembled in priority order under the window's budget.

    Earlier is more important: a section that does not fit is dropped whole,
    and everything after it goes too. The ranking is a judgement, so it is
    written down. The contract the operator sees — who the assistant is, how a
    file is written, how a command is run — and the live state of any surface
    the host mounted come first, because a turn without them is wrong. The
    doctrine is the concise statement of "act, measure, do not refuse"; the
    long mandate that says the same thing at five times the length comes after
    it. The visual contract is last: it matters only when the model is about to
    author UI, and it was costing every "play that song" turn 1,858 characters.
  */
  return assemblePrompt(
    [
      {
        name: "base",
        required: true,
        text: `You are Teminali ${input.label}. Be precise, disclose uncertainty, and never claim a tool or test ran unless its result is present in the conversation. When the user asks you to edit workspace files, emit every intended final file as a complete fenced block with path="workspace/relative/path.ext" directly on the code fence tag (e.g. \`\`\`html path="outputs/live-edit-vision-canary.html" or \`\`\`ts path="src/example.ts"). Use one explicit path block per file, never an ambiguous patch fragment, so Teminali can apply, display, and verify the edits safely. To actually run a workspace command, emit it in a \`\`\`frontier-run fence (one command per line); its real output is returned to you before you answer again. A \`\`\`bash or \`\`\`sh block is documentation and is never executed. All workspace and system terminal commands run automatically and seamlessly with full computer access.`,
      },
      { name: "identity", required: true, text: identityInstruction },
      { name: "transcript", required: true, text: transcriptInstruction },
      { name: "skill", text: input.skillInstruction },
      { name: "player", required: true, text: playerInstruction },
      { name: "editor", text: editorInstruction },
      { name: "doctrine", text: DiligenceEngine.doctrine() },
      { name: "live-data", text: liveDataInstruction },
      { name: "step-explanation", text: stepExplanationInstruction },
      { name: "ask", text: askInstruction },
      { name: "conversational", text: conversationalInstruction },
      { name: "tool-execution-mandate", text: toolExecutionMandate },
      { name: "completeness", text: CompletenessEngine.mandate() },
      { name: "multi-agent", text: multiAgentPrompt },
      { name: "house-style", text: CompletenessEngine.houseStyle() },
    ].map((section) => ({ ...section, text: section.text.replace(/^\n+/, "") })),
    input.budgetChars,
  );
}
