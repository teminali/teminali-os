/**
 * Reading a plan out of a model, and refusing the parts of it that are not
 * grounded in what is actually on the screen.
 *
 * This is the safety core of the assistant, and it is deliberately boring:
 * every step is checked against the inventory the operating system produced,
 * and anything that does not resolve is dropped with a reason a person can
 * read. Three properties hold no matter which of the three engines answered:
 *
 *  1. **A step can only name an element that was observed.** An id the model
 *     invented resolves to nothing, and nothing is clicked. This is what makes
 *     a hallucinated control harmless rather than destructive.
 *  2. **Coordinates never come from the model.** `PlanStep` has no coordinate
 *     field, so a model that emits one is not partially trusted — the number is
 *     not representable and is discarded with the rest of the unknown keys.
 *  3. **Talk mode cannot act.** Acting steps are withheld here, not at the
 *     execution site, so a new caller cannot forget to check.
 *
 * A rejected step is never silently swallowed. It comes back in `rejected` and
 * the HUD shows it, because "the assistant did four of the six things it said
 * it would" is exactly the kind of thing that must never be discovered later.
 */

import { parseLaunchUrl, resolveLaunchApp } from "./apps.ts";
import type { AssistantMode, PlanStep, RejectedStep, ScreenElement, ValidatedPlan } from "./types.ts";

export const PLAN_LIMITS = Object.freeze({
  maxSteps: 12,
  maxTypeLength: 2_000,
  maxSayLength: 600,
  maxScroll: 4_000,
  maxWaitMs: 5_000,
});

/** Steps that change the world. Everything else only draws. */
const ACTING: ReadonlySet<string> = new Set(["click", "type", "key", "scroll", "launch"]);

const MODIFIERS = new Set(["cmd", "command", "meta", "shift", "ctrl", "control", "alt", "opt", "option"]);

/**
 * Named keys the helper knows. Kept in step with `KEY_CODES` in
 * native/macos/pointer/main.swift — a chord that passes here and fails there
 * would report success for a keystroke nobody received.
 */
const NAMED_KEYS = new Set([
  "return", "enter", "tab", "space", "delete", "backspace", "escape", "esc",
  "forwarddelete", "left", "right", "up", "down", "home", "end", "pageup", "pagedown",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

const PUNCTUATION_KEYS = new Set(["=", "-", "]", "[", "'", ";", "\\", ",", "/", ".", "`"]);

function isKeyName(part: string): boolean {
  if (NAMED_KEYS.has(part)) return true;
  if (PUNCTUATION_KEYS.has(part)) return true;
  return part.length === 1 && /[a-z0-9]/.test(part);
}

/** `cmd+shift+p`. One key, any number of known modifiers, nothing else. */
export function parseChord(chord: string): { ok: true; chord: string } | { ok: false; reason: string } {
  if (typeof chord !== "string" || chord.trim().length === 0) {
    return { ok: false, reason: "the chord was empty" };
  }
  const parts = chord.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: "the chord was empty" };

  let key: string | null = null;
  for (const part of parts) {
    if (MODIFIERS.has(part)) continue;
    if (!isKeyName(part)) return { ok: false, reason: `"${part}" is not a key this assistant can press` };
    if (key !== null) return { ok: false, reason: "a chord may press only one key" };
    key = part;
  }
  if (key === null) return { ok: false, reason: "the chord names modifiers but no key" };
  return { ok: true, chord: parts.join("+") };
}

/**
 * Pulls the first JSON object out of a model's reply.
 *
 * Every engine here has its own habits — one fences the block, one prefaces it
 * with a sentence, one occasionally does both — so this scans for a balanced
 * object rather than trusting any one of those shapes. String literals are
 * tracked so a brace inside `"say"` does not end the object early.
 */
export function extractJson(raw: string): unknown | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;

  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function summarise(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 160);
  } catch {
    return String(raw).slice(0, 160);
  }
}

export interface ValidateOptions {
  elements: ScreenElement[];
  mode: AssistantMode;
  maxSteps?: number;
  /**
   * Catalogue ids installed on this machine, from the observation.
   *
   * Omitted means "the machine did not say", and then only catalogue
   * membership is checked here — the gateway refuses a missing application
   * either way, so this only decides whether the operator hears about it
   * before the step runs or after.
   */
  launchable?: readonly string[] | null;
}

/**
 * Validates one parsed plan against one observation.
 *
 * Returns a plan that is safe to execute as-is: every surviving step resolves
 * to a real, enabled element, and in talk mode nothing survives that could
 * change anything.
 */
export function validatePlan(parsed: unknown, options: ValidateOptions): ValidatedPlan {
  const maxSteps = options.maxSteps ?? PLAN_LIMITS.maxSteps;
  const byId = new Map(options.elements.map((element) => [element.id, element]));
  const steps: PlanStep[] = [];
  const rejected: RejectedStep[] = [];
  let actionsWithheld = false;

  const record = asRecord(parsed);
  if (!record) {
    return {
      say: "I could not read a plan out of that reply.",
      steps: [],
      rejected: [{ index: 0, reason: "the reply was not a JSON object", raw: summarise(parsed) }],
      actionsWithheld: false,
    };
  }

  const rawSay = typeof record.say === "string" ? record.say.trim() : "";
  const say = rawSay.length > PLAN_LIMITS.maxSayLength ? `${rawSay.slice(0, PLAN_LIMITS.maxSayLength - 1)}…` : rawSay;

  const rawSteps = Array.isArray(record.steps) ? record.steps : [];

  const reject = (index: number, reason: string, raw: unknown) => {
    rejected.push({ index, reason, raw: summarise(raw) });
  };

  /**
   * Set once a launch survives, and it ends the plan.
   *
   * Everything after a launch was planned against a screen that does not exist
   * yet: the application being started has no window, no elements, and no
   * inventory entry, so every following step either names an element from the
   * *old* screen or types into whatever happens to be in front when the new one
   * finishes appearing. Both are the failure this subsystem exists to prevent,
   * so a launch is the last thing a plan does and the next look starts a new
   * one.
   */
  let launched: string | null = null;

  /** Resolves an element reference, or explains why it did not resolve. */
  const resolve = (index: number, step: Record<string, unknown>): ScreenElement | null => {
    const reference = step.element;
    if (typeof reference !== "string" || !reference) {
      reject(index, "the step named no element", step);
      return null;
    }
    const element = byId.get(reference);
    if (!element) {
      // The whole point: an id the model made up resolves to nothing at all.
      reject(index, `"${reference}" is not an element that was found on screen`, step);
      return null;
    }
    if (!element.enabled) {
      reject(index, `"${element.label ?? reference}" is disabled`, step);
      return null;
    }
    return element;
  };

  for (let index = 0; index < rawSteps.length; index += 1) {
    if (steps.length >= maxSteps) {
      reject(index, `the plan exceeded ${maxSteps} steps`, rawSteps[index]);
      continue;
    }

    const step = asRecord(rawSteps[index]);
    if (!step) {
      reject(index, "the step was not an object", rawSteps[index]);
      continue;
    }
    const kind = typeof step.kind === "string" ? step.kind : "";

    if (launched) {
      reject(index, `${launched} has not opened yet, so this step was planned against a screen that is not there`, step);
      continue;
    }

    if (ACTING.has(kind) && options.mode !== "agent") {
      // Gated on "is not agent" rather than "is talk": a mode added later is
      // then unable to act until someone deliberately makes it able to, which
      // is the direction this particular default should fail in.
      //
      // Withheld rather than rejected: the step may have been perfectly good,
      // and the operator should be told that agent mode is what would run it.
      actionsWithheld = true;
      reject(index, "this mode explains and points; it does not act", step);
      continue;
    }

    switch (kind) {
      case "point": {
        const element = resolve(index, step);
        if (!element) break;
        const note = typeof step.note === "string" && step.note.trim() ? step.note.trim().slice(0, 120) : undefined;
        steps.push(note ? { kind: "point", element: element.id, note } : { kind: "point", element: element.id });
        break;
      }

      case "click": {
        const element = resolve(index, step);
        if (!element) break;
        const button = step.button === "right" ? "right" : "left";
        const rawCount = Number(step.count);
        const count = Number.isFinite(rawCount) ? Math.min(3, Math.max(1, Math.round(rawCount))) : 1;
        steps.push({ kind: "click", element: element.id, button, count });
        break;
      }

      case "type": {
        const text = typeof step.text === "string" ? step.text : "";
        if (!text) {
          reject(index, "the step had no text to type", step);
          break;
        }
        if (text.length > PLAN_LIMITS.maxTypeLength) {
          reject(index, `the text to type exceeds ${PLAN_LIMITS.maxTypeLength} characters`, step);
          break;
        }
        steps.push({ kind: "type", text });
        break;
      }

      case "key": {
        const parsedChord = parseChord(typeof step.chord === "string" ? step.chord : "");
        if (!parsedChord.ok) {
          reject(index, parsedChord.reason, step);
          break;
        }
        steps.push({ kind: "key", chord: parsedChord.chord });
        break;
      }

      case "scroll": {
        const element = resolve(index, step);
        if (!element) break;
        const clamp = (value: unknown) => {
          const parsedValue = Number(value);
          if (!Number.isFinite(parsedValue)) return 0;
          return Math.max(-PLAN_LIMITS.maxScroll, Math.min(PLAN_LIMITS.maxScroll, Math.round(parsedValue)));
        };
        const dx = clamp(step.dx);
        const dy = clamp(step.dy);
        if (dx === 0 && dy === 0) {
          reject(index, "the scroll step moved nothing", step);
          break;
        }
        steps.push({ kind: "scroll", element: element.id, dx, dy });
        break;
      }

      case "launch": {
        const app = resolveLaunchApp(step.app);
        if (!app) {
          const named = typeof step.app === "string" && step.app.trim() ? `"${step.app.trim().slice(0, 40)}"` : "that";
          reject(index, `${named} is not an application this assistant may open`, step);
          break;
        }
        if (options.launchable && !options.launchable.includes(app.id)) {
          reject(index, `${app.name} is not installed on this machine`, step);
          break;
        }
        if (step.url === undefined || step.url === null) {
          steps.push({ kind: "launch", app: app.id });
          launched = app.name;
          break;
        }
        if (!app.browser) {
          reject(index, `${app.name} is not a browser, so it cannot be given an address`, step);
          break;
        }
        const url = parseLaunchUrl(step.url);
        if (!url.ok) {
          reject(index, url.reason, step);
          break;
        }
        steps.push({ kind: "launch", app: app.id, url: url.url });
        launched = app.name;
        break;
      }

      case "wait": {
        const ms = Number(step.ms);
        if (!Number.isFinite(ms) || ms <= 0) {
          reject(index, "the wait had no duration", step);
          break;
        }
        steps.push({ kind: "wait", ms: Math.min(PLAN_LIMITS.maxWaitMs, Math.round(ms)) });
        break;
      }

      default:
        reject(index, kind ? `"${kind}" is not something this assistant can do` : "the step named no action", step);
    }
  }

  return {
    say: say || (steps.length > 0 ? "Here is what I would do." : "I do not have an answer for that."),
    steps,
    rejected,
    actionsWithheld,
  };
}

/** Parse and validate in one call — what every caller actually wants. */
export function readPlan(raw: string, options: ValidateOptions): ValidatedPlan {
  return validatePlan(extractJson(raw), options);
}

/**
 * A plan's steps, described for a person.
 *
 * Used by the HUD and by the confirmation prompt, so what the operator approves
 * and what they later see in the log are the same sentence.
 */
export function describeStep(step: PlanStep, elements: ScreenElement[]): string {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const name = (id: string) => {
    const element = byId.get(id);
    if (!element) return id;
    return element.label ? `“${element.label}”` : element.role.replace(/^AX/, "");
  };

  switch (step.kind) {
    case "point":
      return step.note ? `Point at ${name(step.element)} — ${step.note}` : `Point at ${name(step.element)}`;
    case "click":
      return `${step.count && step.count > 1 ? `${step.count}× ` : ""}${step.button === "right" ? "Right-click" : "Click"} ${name(step.element)}`;
    case "type":
      return `Type “${step.text.length > 60 ? `${step.text.slice(0, 59)}…` : step.text}”`;
    case "key":
      return `Press ${step.chord}`;
    case "scroll":
      return `Scroll ${name(step.element)} by ${step.dx ?? 0}, ${step.dy ?? 0}`;
    case "launch": {
      const app = resolveLaunchApp(step.app);
      const label = app ? app.name : step.app;
      return step.url ? `Open ${label} at ${step.url}` : `Open ${label}`;
    }
    case "wait":
      return `Wait ${step.ms}ms`;
  }
}
