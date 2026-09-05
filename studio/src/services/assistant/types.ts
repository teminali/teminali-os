/**
 * Screen assistant — shared contracts.
 *
 * Declarations only. Every runtime module in this folder is import-free at
 * runtime so `tests/*.test.mjs` can reach it through Node's type stripping;
 * a type-only import is erased, so this file costs nothing at run time.
 *
 * The shape that matters most is `PlanStep`. Notice what it does not have: a
 * coordinate. Not on any variant, not optionally, nowhere. A model asked to
 * read pixel positions off a screenshot produces numbers that are plausible and
 * wrong, and in agent mode a plausible-and-wrong number clicks the row below
 * the one you asked for. So the model names an element and the frame the
 * operating system reported for that element is what gets clicked. Making the
 * coordinate unrepresentable in the protocol is what turns that from a
 * convention into a guarantee.
 */

import type { LaunchableEntry } from "./apps.ts";

export type { LaunchableEntry };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenInfo {
  id: number;
  main: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Backing pixels per point. A 2× screen reports 2. */
  scale: number;
}

/** One element as the accessibility API reported it. Never inferred. */
export interface ScreenElement {
  /** Assigned by the helper during the walk. Stable for one observation only. */
  id: string;
  role: string;
  subrole?: string;
  label?: string;
  value?: string;
  frame: Rect;
  enabled: boolean;
  focused: boolean;
  actions: string[];
  depth: number;
  /** Ancestor breadcrumb, for disambiguating two buttons with the same title. */
  path: string;
}

export interface ObservedApplication {
  name: string;
  bundleId: string;
  pid: number;
}

export interface Observation {
  /** Server-held id. An action may only refer to elements from this snapshot. */
  id: string;
  capturedAt: string;
  application: ObservedApplication;
  window: { title?: string; frame?: Rect } | null;
  screens: ScreenInfo[];
  elements: ScreenElement[];
  /** True when the walk hit its budget and the inventory is partial. */
  truncated: boolean;
  /** What the local vision model saw. Context for reasoning, never geometry. */
  sceneDescription: string | null;
  /** Where the frame was written, and how big it is. */
  frame: { path: string; width: number; height: number } | null;
  /**
   * Every application installed on this machine that a `launch` may start.
   *
   * Answered by the gateway rather than assumed, so the model is offered the
   * applications this operator actually has instead of a list it has to guess
   * against. Entries rather than bare ids because an application discovered by
   * scanning the disk has a name and a `browser` flag that exist nowhere else.
   * Absent on an observation from a build that predates `launch`.
   */
  launchable?: LaunchableEntry[];
}

/**
 * What an utterance does.
 *
 * `dictate` — the words go into the composer, repaired and shown for approval.
 * `talk`    — the assistant looks at the screen, explains, and points.
 * `agent`   — the assistant may act, subject to the autonomy rung below.
 *
 * Three modes of one assistant rather than a dictation recorder beside a screen
 * assistant. The microphone in the composer and the global hotkey are two doors
 * into the same session; this is the switch that decides what happens once you
 * are through one of them.
 */
export type AssistantMode = "dictate" | "talk" | "agent";

export const ASSISTANT_MODES: AssistantMode[] = ["dictate", "talk", "agent"];

/**
 * How much the assistant may do without being asked, safest first.
 *
 * `guide`   — nothing is executed; every step is drawn and described.
 * `confirm` — each acting step is approved by the operator before it runs.
 * `auto`    — the plan runs to completion.
 *
 * The default is `auto`, changed by the operator on 2026-09-03. It was `confirm`
 * on the reasoning that a thing which can click anything on your screen without
 * asking is a choice made explicitly — and this is that choice, made once, for
 * the product rather than per session. A hands-free assistant that stops for
 * approval on every click is not hands-free, so the confirmation step moved out
 * of the ladder's default and into the operator's hands: `guide` and `confirm`
 * are still there, one switch away, for anyone who wants the older contract.
 */
export type AssistantAutonomy = "guide" | "confirm" | "auto";

export const ASSISTANT_AUTONOMY_LADDER: AssistantAutonomy[] = ["guide", "confirm", "auto"];

/** Which engine answers. Not hardwired — all three are first-class. */
export type AssistantEngine = "frontier" | "claude" | "codex";

export type AssistantFrontierMode = "flash" | "auto" | "max";

export type PlanStep =
  /** Draw attention to an element. The only step `talk` mode ever performs. */
  | { kind: "point"; element: string; note?: string }
  | { kind: "click"; element: string; button?: "left" | "right"; count?: number }
  | { kind: "type"; text: string }
  | { kind: "key"; chord: string }
  | { kind: "scroll"; element: string; dx?: number; dy?: number }
  /**
   * Press on one element, travel, and release.
   *
   * The destination is expressed one of two ways, never both. `to` names a
   * second element, which is what a reorder or a drop onto a target is. `dx`/
   * `dy` is a displacement in points from the centre of `element`, which is
   * what a slider is: there is no element at "seventy percent along the
   * track", only a distance from where the thumb is now.
   *
   * A displacement is not a coordinate read off a screenshot. The origin still
   * comes from the accessibility API, and the offset is arithmetic on it, so
   * this stays inside the rule that no position is ever derived from pixels.
   */
  | { kind: "drag"; element: string; to?: string; dx?: number; dy?: number; button?: "left" | "right" }
  /**
   * Start an application, optionally at a web address.
   *
   * The one step that does not name an element, because the whole point of it
   * is that the thing it wants is not on the screen yet. `app` is an id from
   * the catalogue in apps.ts — never a path, never a command — so a model that
   * asks to start something that is not in that catalogue starts nothing, the
   * same way an invented element id clicks nothing.
   */
  | { kind: "launch"; app: string; url?: string }
  /**
   * Bring an application that is already running to the front.
   *
   * The sibling of `launch`, and separate from it because starting a program
   * and switching to one are different acts with different costs. `launch` on
   * something already open is at best a no-op and at worst a second window;
   * `focus` on something that is not running fails honestly rather than
   * quietly starting it. Like `launch` it names an application rather than an
   * element, because the thing it wants is by definition not on this screen.
   */
  | { kind: "focus"; app: string }
  | { kind: "wait"; ms: number };

export type PlanStepKind = PlanStep["kind"];

/** A step that did not survive validation, and the reason in plain words. */
export interface RejectedStep {
  index: number;
  reason: string;
  /** What the model actually asked for, so the HUD can show it verbatim. */
  raw: string;
}

export interface ValidatedPlan {
  /** Spoken aloud. Always present, even when every step was rejected. */
  say: string;
  steps: PlanStep[];
  rejected: RejectedStep[];
  /** True when acting steps were dropped because the mode forbids acting. */
  actionsWithheld: boolean;
}

/** One executed step, as reported back to the operator. */
export interface StepOutcome {
  index: number;
  step: PlanStep;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
}

export interface AssistantCapabilities {
  supported: boolean;
  helperBuilt: boolean;
  accessibilityTrusted: boolean;
  screenRecordingGranted: boolean;
  detail: string | null;
}

export interface AssistantSettings {
  mode: AssistantMode;
  autonomy: AssistantAutonomy;
  engine: AssistantEngine;
  frontierMode: AssistantFrontierMode;
  /** Read the answer aloud. */
  speak: boolean;
  /** Electron accelerator, e.g. "CommandOrControl+Shift+Space". */
  hotkey: string;
  /** Draw the pointer guidance on the real screen, not just in the window. */
  overlay: boolean;
  /** Keep the voice session listening continuously for screen commands without pressing buttons. */
  handsFree: boolean;
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  mode: "agent",
  autonomy: "auto",
  engine: "frontier",
  frontierMode: "auto",
  speak: true,
  hotkey: "CommandOrControl+Shift+Space",
  overlay: true,
  handsFree: true,
};
