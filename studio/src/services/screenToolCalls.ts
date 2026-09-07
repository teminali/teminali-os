// The screen contract: how the local lane looks at what is on the display.
//
// The fifth sibling of agentCommands.ts, videoToolCalls.ts, playerToolCalls.ts
// and askToolCalls.ts, and shaped like all four — parse an explicit fence,
// execute through an injected capability, hand the model back what actually
// happened.
//
// The gap it closes: the screen assistant is reachable by an agent CLI, over
// the run-token bridge in `server/gateway.js`, and by the operator's own
// clicks. It was not reachable by the lane the operator is usually talking to,
// so "what's this error on my screen?" was answered by a lane that cannot see
// the screen — which means answered by guessing, or by a shell command
// hunting for a log that may not exist.
//
// Read-only, deliberately. `look` observes and changes nothing. Acting on the
// screen — clicking, typing — stays where the operator's consent is asked for
// per action, and giving a local model hands on the machine through a fence it
// can emit unprompted is a different decision from letting it read the screen
// it was asked about. See DESIGN.md §5, "Autonomy is a ladder".
import type { ToolCall } from "../types";

/**
 * Only an explicit opt-in fence is executed, for the same reason every other
 * runner in this family insists on one: a model routinely prints example JSON
 * as documentation, and treating that as an instruction would take a
 * screenshot because a sentence explained how looking works.
 *
 * The negative lookahead keeps ```screenshot and ```screen-recording out; the
 * forgiving list below is where a half-remembered tag is caught on purpose.
 */
const SCREEN_FENCE = /```screen(?![-\w])[^\n]*\n([\s\S]*?)(?:```|$)/g;

/**
 * What a local model writes when it has half-remembered the fence name. The
 * ask, player and editor runners carry the same list for the same reason: a
 * model that has understood the protocol and mistyped the tag has earned its
 * call.
 */
const FALLBACK_FENCE = /```(?:screen-tool|screen_tool|screentool|look|look-tool|see-screen|read-screen)[^\n]*\n([\s\S]*?)(?:```|$)/g;

/** The only action. Named rather than implied so the prompt and the parser agree. */
export const SCREEN_ACTIONS = ["look"] as const;

export interface ScreenLook {
  action: "look";
  /**
   * What the model is trying to find out. Passed through to the observation so
   * a large screen is summarised toward the question rather than transcribed —
   * and, when the observation comes back thin, so the reply can say what it
   * was looking for rather than "I could not see anything".
   */
  question?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function toLook(value: unknown): ScreenLook | null {
  if (!isRecord(value)) return null;
  const action = typeof value.action === "string" ? value.action.trim().toLowerCase() : "";
  // An empty object in a `screen` fence is unambiguous — there is one action —
  // so it is honoured. A *named* action that is not `look` is not: inventing
  // "click" and having it silently observe would teach the model it can act.
  if (action && action !== "look") return null;
  const question = typeof value.question === "string" ? value.question.trim() : "";
  return question ? { action: "look", question } : { action: "look" };
}

/**
 * Every look requested by one reply, in order, deduplicated.
 *
 * Deduplicated because a model that asks to look twice in one reply is asking
 * about one screen: the second observation would be of the same display a
 * moment later, and the cost of a second one is a second screenshot in an
 * already tight window.
 */
export function parseScreenToolCalls(text: string): ScreenLook[] {
  const looks: ScreenLook[] = [];
  for (const pattern of [SCREEN_FENCE, FALLBACK_FENCE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const body = match[1] ?? "";
      const parsed = tryParse(body);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        const look = toLook(candidate);
        if (look) looks.push(look);
      }
    }
    // A well-formed `screen` fence is the answer; the forgiving list is only
    // consulted when the strict tag found nothing, so a reply that documents
    // ```look while correctly using ```screen does not look twice.
    if (looks.length > 0) break;
  }
  return looks.slice(0, 1);
}

/** The tool-call row the chat draws for a look, before its result is known. */
export function screenToolCall(look: ScreenLook): ToolCall {
  return {
    id: `screen-${Date.now()}`,
    name: "look at the screen",
    arguments: look.question ? { question: look.question } : {},
    status: "running",
  };
}

/* ── What the lane is told it saw ──────────────────────────────────────────── */

/**
 * The subset of an `Observation` this summary reads.
 *
 * Structural rather than an import of the assistant's own type, so the rule
 * below stays testable without a browser and without the assistant's module
 * graph — the same reason `messageTelemetry.ts` and `chatSessions.ts` are
 * shaped this way.
 */
export interface ScreenSummarySource {
  application: { name: string };
  window?: { title?: string } | null;
  sceneDescription?: string | null;
  truncated?: boolean;
  elements?: { role: string; label?: string; value?: string; focused?: boolean }[];
}

/**
 * How many elements are named. The screen assistant's own prompt takes 120;
 * this lane has an 8k window that the eval already shows dropping five
 * sections, so it takes the first dozen and says the list was cut.
 */
const MAX_SUMMARY_ELEMENTS = 12;
/** A value longer than this is a document, not a label. */
const MAX_VALUE_CHARS = 80;

function elementLine(el: { role: string; label?: string; value?: string; focused?: boolean }): string {
  const label = (el.label ?? "").trim();
  const value = (el.value ?? "").trim().slice(0, MAX_VALUE_CHARS);
  const named = [label, value && value !== label ? `“${value}”` : ""].filter(Boolean).join(" ");
  return `- ${el.role}${named ? `: ${named}` : ""}${el.focused ? " (focused)" : ""}`;
}

/**
 * One observation, written short enough for the local lane's window.
 *
 * Elements with neither a label nor a value are dropped: a bare `AXGroup`
 * tells the model nothing and costs it a line. What is kept is what a person
 * asked "what's on my screen" would answer with — which application, which
 * window, what the screenshot showed, and the handful of controls that have
 * names.
 *
 * The truncation is always stated. A model told "12 elements" that is really
 * looking at a summary of 300 will conclude something is absent when it was
 * only cut, and reporting an absence that was never observed is the same
 * invention this capability exists to remove.
 */
export function summariseScreen(observation: ScreenSummarySource, question?: string): string {
  const lines: string[] = [];
  if (question) lines.push(`Looking for: ${question}`);
  lines.push(`Frontmost application: ${observation.application.name}`);
  const title = observation.window?.title?.trim();
  if (title) lines.push(`Window: ${title}`);
  const scene = observation.sceneDescription?.trim();
  if (scene) lines.push("", "What the screenshot shows:", scene);

  const named = (observation.elements ?? []).filter((el) => (el.label ?? "").trim() || (el.value ?? "").trim());
  if (named.length > 0) {
    const shown = named.slice(0, MAX_SUMMARY_ELEMENTS);
    lines.push("", `On screen (${shown.length} of ${named.length}${observation.truncated ? "+" : ""}):`);
    lines.push(...shown.map(elementLine));
    if (named.length > shown.length || observation.truncated) {
      lines.push("This list was cut to fit. Something missing from it may still be on screen — say so rather than reporting it absent.");
    }
  } else {
    lines.push("", "No named controls were reported. Describe only what the screenshot above shows.");
  }
  return lines.join("\n");
}
