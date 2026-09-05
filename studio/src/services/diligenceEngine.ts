/**
 * Diligence Engine — how the model investigates before it answers.
 *
 * CompletenessEngine governs the *output* a model emits (no placeholders, no
 * half-wired handlers). This governs the *inquiry* that precedes it: did the
 * model look at the machine before describing it, did it break the answer down
 * to something actionable, did it verify a claim before recommending an
 * irreversible action, did it say what its number actually measures.
 *
 * The task class is not "disk usage". It is every question whose true answer
 * lives on the user's machine rather than in the weights — what is taking the
 * space, what is holding the port, which dependency is bloating the bundle,
 * which tests actually fail, what version is really installed — followed by
 * advice about what to do with it. Storage was simply the first one to expose
 * the gap.
 *
 * These rules are deliberately not a specialist skill. A skill is domain
 * expertise the user opts into for a task ("build a website"); diligence
 * applies to every task, and the moment it becomes optional is the moment the
 * engine ships a confident wrong answer. It also cannot live in the prompt
 * alone: an 8k-context local model reliably forgets a list of dispositions by
 * the time it is answering, so each rule here is *checked* after the fact and
 * fed back through the same correction channel the completeness audit uses.
 */
import type { CommandExecution } from "./agentCommands";

export interface DiligenceFinding {
  rule: string;
  detail: string;
}

export interface InvestigationAudit {
  /** What the user actually asked. */
  userPrompt: string;
  /** The answer the model is about to deliver. */
  answerText: string;
  /** Every command that ran this exchange, in order. */
  executions: CommandExecution[];
  /** Whether the host could have run a command at all. */
  canRunCommands: boolean;
}

/**
 * A question about real state is an intent to measure *plus* a concrete thing
 * to measure it on. Both halves are required: "how many ways could I refactor
 * this" is a design question, not an inspection, and treating it as one would
 * burn a generation turn demanding evidence that does not exist.
 */
const MEASUREMENT_INTENT = new RegExp(
  [
    "how (?:much|many|big|large|old|fast|slow)",
    "\\bwhat(?:'s| is| are)\\b.{0,30}\\b(?:in|inside|on|using|taking|holding|running|listening|installed|available|left)\\b",
    "\\bwhich\\b.{0,40}\\b(?:biggest|largest|heaviest|slowest|failing|fail|unused|stale|duplicate|bloat(?:s|ing)?|eat(?:s|ing)?|hogg(?:s|ing)?)\\b",
    "\\b(?:list|count|measure|inspect|audit|diagnose|profile|analy[sz]e)\\b",
    "\\b(?:show me|find|locate)\\b.{0,30}\\b(?:biggest|largest|heaviest|slowest|failing|unused|stale|duplicate|all)\\b",
    "\\bwhat(?:'s| is)\\b.{0,20}\\b(?:eating|hogging|bloating|slowing)\\b",
    "\\b(?:who|what process)\\b.{0,25}\\b(?:has|holding|using|owns)\\b",
    "\\b(?:out of date|up to date|outdated)\\b",
    "\\bwhy is\\b.{0,40}\\b(?:taking so long|so slow)\\b",
    "\\b(?:is|are)\\b.{0,30}\\b(?:installed|running|failing|passing|up to date|outdated)\\b",
    "\\bwhy is\\b.{0,40}\\b(?:slow|failing|large|big|broken|empty)\\b",
    "\\bcheck\\b.{0,30}\\b(?:if|whether|the|my)\\b",
    // An imperative ask for a figure. "How much" is the question form of the
    // same intent; "give me a total size of all the files in my desktop folder"
    // is the instruction form, and matched nothing until it was seen in use.
    "\\b(?:give|get|tell|show)\\b.{0,20}\\b(?:total|size|count|breakdown|number of)\\b",
    "\\btotal (?:size|count|number|space|files?)\\b",
  ].join("|"),
  "i",
);

/** Something that exists on the machine and can therefore be looked at. */
const CONCRETE_SUBJECT = new RegExp(
  [
    "\\bfiles?\\b|\\bfolders?\\b|\\bdirector(?:y|ies)\\b|\\bdisk\\b|\\bstorage\\b|\\bspace\\b|\\bdrive\\b",
    "\\bmemory\\b|\\bram\\b|\\bcpu\\b|\\bports?\\b|\\bprocess(?:es)?\\b|\\bservice\\b|\\bdaemon\\b",
    "\\bdependenc(?:y|ies)\\b|\\bpackages?\\b|\\bmodules?\\b|node_modules|\\bbundle\\b|\\blockfile\\b",
    "\\btests?\\b|\\bsuite\\b|\\bcoverage\\b|\\bbuild\\b|\\blogs?\\b|\\bcache\\b|\\berrors?\\b",
    "\\bcommits?\\b|\\bbranch(?:es)?\\b|\\brepo\\b|\\bworkspace\\b|\\bproject\\b|\\bcodebase\\b",
    "\\bversions?\\b|\\bconfig\\b|\\benv\\b|\\bdatabase\\b|\\btables?\\b|\\bimages?\\b|\\bvideos?\\b",
    "\\bdownloads?\\b|\\bdesktop\\b|\\bmac\\b|\\bmachine\\b|\\bsystem\\b|\\blaptop\\b",
  ].join("|"),
  "i",
);

/**
 * Phrasings that carry their own subject. "Is postgres running" is a question
 * about this machine whatever postgres is, so requiring a second noun would
 * mean enumerating every program a user might name — a list that is wrong the
 * moment they install something new.
 */
const SELF_EVIDENT_STATE = new RegExp(
  [
    "\\b(?:is|are|was|were)\\b.{0,30}\\b(?:installed|running|listening|failing|passing|outdated|up to date|available)\\b",
    "\\bwhat(?:'s| is)\\b.{0,25}\\b(?:using|taking|holding|listening on|bound to)\\b",
    "\\bwhich version\\b|\\bwhat version\\b",
    "\\bdo i have\\b.{0,30}\\b(?:installed|available)\\b",
  ].join("|"),
  "i",
);

/**
 * Advice questions wearing a measurement word. "How many tests should I write"
 * and "how much memory does a typical process use" quantify a hypothetical, not
 * this machine, and no command can answer them.
 */
const HYPOTHETICAL =
  /\bshould i\b|\bshould a\b|\bshould my\b|\bin general\b|\btypical(?:ly)?\b|\bwould you recommend\b|\bbest practice\b|\bis it worth\b|\bhow (?:do|would) i\b/i;

/** The model asserting it cannot reach the machine it is wired into. */
const CAPABILITY_DENIAL =
  /\b(?:i(?:'m| am) (?:unable|not able)|i can(?:'t|not)\s+(?:directly\s+)?(?:access|read|see|inspect|browse|run|execute|fetch|get)|i do(?:n't| not) have (?:direct )?access|as an ai(?:[ ,]|$)|unable to (?:execute|run|fetch|access|get)|can(?:'t|not) fetch real-time)/i;

/** Deflecting the work back to the user instead of doing it. */
const DEFLECTION =
  /\byou can (?:use|run|try|check)\b|\bhere(?:'s| are| is) (?:how|some) (?:you|to)\b|\bon (?:windows|macos|linux)\b.{0,40}\b(?:open|navigate|right-click)\b|\b(?:please |just |simply )?run (?:this|the following|that) (?:command|in)\b|\b(?:you(?:'ll| will)? (?:need|have) to|try) run(?:ning)?\b|\brun (?:it|this) (?:on|in) your\b|\bexecute the following\b/i;

/** Advice that destroys something. Matched on the imperative, not on prose. */
const DESTRUCTIVE_ADVICE =
  /\b(?:delete|remove|rm -|uninstall|purge|drop (?:the )?table|revoke|overwrite|reset --hard|force[- ]push|clear out|get rid of|safe to (?:delete|remove))\b/i;

/** A command whose purpose is to tell two similar things apart. */
const VERIFYING_BINARY =
  /^\s*(?:md5|md5sum|shasum|sha1sum|sha256sum|cksum|cmp|diff|stat|openssl|git\s+(?:log|show|diff|hash-object|cat-file))\b/;

/**
 * A verifier only verifies when it is given two things to compare. `git status`
 * establishes nothing about whether two installers are the same file, and one
 * `stat` call cannot compare anything to anything.
 */
function comparesTwoThings(command: string): boolean {
  if (!VERIFYING_BINARY.test(command)) return false;
  const operands = command
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter(
      (token) =>
        !token.startsWith("-") &&
        !/^\d+$/.test(token) &&
        !/^(?:log|show|diff|hash-object|cat-file)$/.test(token),
    );
  return operands.length >= 2;
}

/** Items distinguished only by their names looking alike. */
const NAME_ONLY_IDENTITY = /\(\d+\)\.[a-z0-9]{1,5}\b|\bcopy\b|\bduplicate\b|\bidentical\b|\bsame file\b|\bredundant\b/i;

/** A human-readable size that came out of du/ls/df. */
const SIZE_FIGURE = /\b\d+(?:[.,]\d+)?\s*(?:[KMGT]i?B|[KMGT])\b/;

/** Any acknowledgement that binary and decimal units differ. */
const UNIT_DISCLOSURE =
  /\b(?:GiB|MiB|KiB|TiB|binary|decimal|1024|base[- ]?(?:2|10)|Finder (?:will |may )?(?:show|report))\b/i;

/**
 * Commands that collapse many things into one number. Only these create an
 * aggregate worth decomposing: `lsof -i :3000` already names the exact process
 * and `node -v` returns a scalar, so demanding a breakdown of either is asking
 * the model to itemise something that was never summed.
 */
const AGGREGATE_COMMAND = /^\s*du\s+-[a-z]*s|^\s*df\b|\bwc\s+-l\b|^\s*find\b(?![\s\S]*-exec)/;

/** Commands that decompose an aggregate rather than restating it. */
const DRILL_DOWN = /[*]|-maxdepth|\bsort\b|\bhead\b|\btop\b|--depth|\|\s*(?:grep|awk|cut)\b|\/\S+\//;

const ran = (executions: CommandExecution[]) => executions.filter((execution) => execution.executed);

export class DiligenceEngine {
  /**
   * Kept short on purpose. Flash runs an 8k window; every line spent on
   * doctrine is a line not spent on the user's files, and the audit below is
   * what actually holds the behaviour. This is the reminder, not the guarantee.
   */
  private static DOCTRINE = `[FRONTIER INVESTIGATION DOCTRINE — APPLIES TO EVERY TASK]:
1. Act with full machine access via \`\`\`frontier-run fences — you are not a chat assistant handing out instructions. All commands run seamlessly. Measure real state or live data in a fence; never claim you lack access, never give up on initial errors, and never tell the user to run commands or check websites themselves. If an API or command fails, persistently self-think and try alternative solutions.
2. Do not stop at the headline number. Decompose a total until the answer names the specific items the user would act on.
3. Verify before you recommend anything irreversible. Two things with similar names are not the same thing until a checksum, a diff, or a stat says so.
4. Say what your number measures. A size from \`du\` is binary (GiB) while Finder shows decimal (GB); a count from \`find\` may include symlinks. Name the caveat so a mismatch does not read as an error.
5. Report the commands you actually ran and what they returned. Never describe the result of a command whose output you did not receive — end your turn at the closing fence and wait, because the real output comes back to you before you answer again.`;

  public static wrapSystemPrompt(basePrompt: string): string {
    return `${basePrompt}\n\n${this.DOCTRINE}`;
  }

  /** True when answering honestly requires looking at the machine. */
  public static needsEvidence(userPrompt: string): boolean {
    if (HYPOTHETICAL.test(userPrompt)) return false;
    if (SELF_EVIDENT_STATE.test(userPrompt)) return true;
    return MEASUREMENT_INTENT.test(userPrompt) && CONCRETE_SUBJECT.test(userPrompt);
  }

  /**
   * Audits the inquiry behind an answer.
   *
   * Conservative by construction: every rule requires positive evidence that
   * something was skipped, because a false finding costs a whole generation
   * turn on a local model.
   */
  public static auditInvestigation(input: InvestigationAudit): DiligenceFinding[] {
    const { userPrompt, answerText, canRunCommands } = input;
    const findings: DiligenceFinding[] = [];
    const add = (rule: string, detail: string) => findings.push({ rule, detail });
    const executed = ran(input.executions);
    const inspectable = this.needsEvidence(userPrompt);

    // ── 1. Claimed inability while wired to a shell ──
    if (canRunCommands && CAPABILITY_DENIAL.test(answerText)) {
      add(
        "capability-denial",
        "You told the user you cannot reach their machine. You can: emit a ```frontier-run fence and the real output comes back to you before you answer again.",
      );
    }

    // ── 2. Answered a question about real state from memory ──
    if (canRunCommands && executed.length === 0 && inspectable) {
      add(
        "ungrounded-answer",
        "This question is about the actual state of the machine and no command was run. Measure it in a ```frontier-run fence, then answer from the output.",
      );
    }

    // ── 3. Handed the work back instead of doing it ──
    if (canRunCommands && executed.length === 0 && inspectable && DEFLECTION.test(answerText)) {
      add(
        "deflected-to-user",
        "You explained how the user could find this out themselves. Run it for them and give them the answer.",
      );
    }

    // ── 4. Stopped at the aggregate ──
    if (executed.length > 0 && inspectable) {
      const aggregated = executed.some((execution) => AGGREGATE_COMMAND.test(execution.command));
      const drilled = executed.some((execution) => DRILL_DOWN.test(execution.command));
      if (aggregated && !drilled) {
        add(
          "aggregate-without-breakdown",
          "You reported a total without decomposing it. Run the per-item version (e.g. `du -sh <dir>/* | sort -hr`, `npm ls --depth=1`, a failing-test list) so the answer names what the user can act on.",
        );
      }
    }

    // ── 5. Recommended something irreversible without establishing identity ──
    if (canRunCommands && DESTRUCTIVE_ADVICE.test(answerText) && NAME_ONLY_IDENTITY.test(answerText)) {
      const verified = executed.some((execution) => comparesTwoThings(execution.command));
      if (!verified) {
        add(
          "unverified-destructive-advice",
          "You advised destroying something identified only by its name looking like another's. Establish identity first (`md5 a b`, `diff a b`, `git log --oneline a`), or state plainly that you have not verified they are the same.",
        );
      }
    }

    // ── 6. Reported a size without saying what it measures ──
    if (SIZE_FIGURE.test(answerText) && !UNIT_DISCLOSURE.test(answerText)) {
      const fromSizeTool = executed.some((execution) => /^\s*(?:du|df|ls)\b/.test(execution.command));
      if (fromSizeTool) {
        add(
          "undisclosed-units",
          "`du` and `df` report binary units (GiB) while Finder reports decimal (GB). Name the unit so the two numbers not matching does not read as an error.",
        );
      }
    }

    return findings;
  }

  /** Renders findings as the correction turn the model reads next. */
  public static formatDiligenceBrief(findings: DiligenceFinding[]): string {
    const lines = findings.map((finding, index) => `${index + 1}. [${finding.rule}] ${finding.detail}`);
    return [
      "[FRONTIER INVESTIGATION REVIEW] Your answer was checked before delivery and is not yet grounded:",
      ...lines,
      "",
      "Correct this now. Run the commands you need in a ```frontier-run fence, then give the complete answer from their real output.",
    ].join("\n");
  }
}
