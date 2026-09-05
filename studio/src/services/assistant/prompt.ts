/**
 * The prompt the assistant asks with, built the same way for all three engines.
 *
 * One prompt rather than three is a deliberate constraint. Claude Code and
 * Codex are agent CLIs with their own tools; Frontier is a local model behind
 * the gateway. What they share is that they are being asked one narrow
 * question — "given these elements, what should happen?" — and are answering in
 * one narrow shape. Anything engine-specific in here would mean the assistant
 * behaved differently depending on which engine was selected, which is the one
 * thing the operator did not ask for when they switched engines.
 *
 * The instruction that carries the whole design is the second rule: the model
 * is told it cannot see coordinates and must not invent them. The validator
 * enforces that regardless (see plan.ts), but a model that has been told the
 * truth about its own inputs produces better plans than one that is silently
 * corrected afterwards.
 */

import { launchableInventory } from "./apps.ts";
import type { AssistantMode, Observation, ScreenElement } from "./types.ts";

export interface PromptOptions {
  question: string;
  mode: AssistantMode;
  observation: Observation;
  /** The ranked inventory. Not the full tree. */
  elements: ScreenElement[];
  inventory: string;
}

const SHAPE = `{
  "say": "one or two sentences, spoken aloud — plain language, no markdown",
  "steps": [
    { "kind": "point",  "element": "e12", "note": "why this one" },
    { "kind": "click",  "element": "e12", "button": "left", "count": 1 },
    { "kind": "type",   "text": "what to type" },
    { "kind": "key",    "chord": "cmd+s" },
    { "kind": "scroll", "element": "e4", "dy": -300 },
    { "kind": "drag",   "element": "e7", "to": "e9" },
    { "kind": "drag",   "element": "e7", "dx": 120, "dy": 0 },
    { "kind": "launch", "app": "safari", "url": "https://example.com" },
    { "kind": "focus",  "app": "slack" },
    { "kind": "wait",   "ms": 400 }
  ]
}`;

export function systemPrompt(mode: AssistantMode): string {
  const shared = [
    "You are the screen assistant inside Teminali Code. You are looking at the operator's actual screen.",
    "",
    "Rules:",
    "1. Answer with one JSON object and nothing else. No prose before it, no code fence around it.",
    "2. You cannot see pixel coordinates and must never write one. Every step that touches the screen names an element by its id from the inventory below. If the element you need is not in the inventory, say so in `say` and return no steps for it.",
    "3. Never invent an id. An id that is not in the inventory will be discarded and the operator will be told you named something that is not there.",
    "4. `say` is read aloud. Write it the way you would say it — short, direct, no lists, no markdown, no ids.",
  ];

  if (mode === "talk") {
    shared.push(
      "5. You are in talk mode. You explain and you point; you do not act. Use only `point` steps. If the operator is asking you to do something rather than explain something, say that agent mode is what does it.",
    );
  } else {
    shared.push(
      "5. You are in agent mode. You may act, but prefer the smallest number of steps that finishes the job, and stop at the point where the operator would want to look before continuing.",
      "6. Do not act on anything destructive, irreversible, or involving credentials, payment, or someone else's data. Describe it in `say` and let the operator do it.",
      "7. If what the operator wants is in an application that is not on screen, open it with a `launch` step. `app` must be an id from the list of applications below — never a name that is not on that list, never a path, never a command. Only a browser may be given a `url`, and only an http or https one.",
      "8. A `launch` must be the last step of the plan. The application it starts has no window yet, so nothing after it could name a real element. Say what you will do next once it is open, and do it on the next turn.",
      "9. If the application is already running, use `focus` rather than `launch`. `focus` brings it to the front; `launch` on something already open is at best wasted and at worst a second window. Like `launch`, a `focus` must be the last step of the plan, for the same reason: the screen after it is not the screen you planned against.",
      "10. A `drag` presses on `element`, travels, and releases. Give it either `to` — a second element id, for a reorder or a drop — or `dx`/`dy`, a displacement in points from the centre of `element`, for a slider or a handle where there is no element at the destination. Never both. Use it only when a click genuinely will not do; most controls are clicked, not dragged.",
    );
  }

  shared.push("", "The shape, exactly:", SHAPE);
  return shared.join("\n");
}

/** The observation, written out for the model. */
export function observationBlock(options: PromptOptions): string {
  const { observation, inventory } = options;
  const lines: string[] = [];

  lines.push(`Frontmost application: ${observation.application.name}`);
  if (observation.window?.title) lines.push(`Window: ${observation.window.title}`);
  const screen = observation.screens.find((entry) => entry.main) ?? observation.screens[0];
  if (screen) lines.push(`Screen: ${Math.round(screen.width)}×${Math.round(screen.height)} points at ${screen.scale}×`);

  if (observation.sceneDescription) {
    lines.push("", "What the screenshot shows (context for reasoning only — never a source of positions):");
    lines.push(observation.sceneDescription.trim());
  }

  lines.push("", `Elements the operating system reports on screen (${options.elements.length}${observation.truncated ? " of more" : ""}), in reading order:`);
  lines.push(inventory);
  if (observation.truncated) {
    lines.push("", "This list was cut to fit. If what you need is plainly missing rather than absent, say so.");
  }

  // Only in agent mode: talk mode cannot run a launch, and offering a
  // capability that will be withheld produces plans that get thrown away.
  if (options.mode === "agent" && observation.launchable && observation.launchable.length > 0) {
    lines.push("", "Applications installed on this machine, which a `launch` step may open:");
    lines.push(launchableInventory(observation.launchable));
  }

  return lines.join("\n");
}

/** The whole thing, as one string, for engines that take a single prompt. */
export function buildPrompt(options: PromptOptions): string {
  return [
    systemPrompt(options.mode),
    "",
    "── Screen ──",
    observationBlock(options),
    "",
    "── The operator said ──",
    options.question.trim(),
    "",
    "Answer with the JSON object now.",
  ].join("\n");
}
