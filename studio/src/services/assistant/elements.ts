/**
 * Turning an accessibility tree into something a model can reason about.
 *
 * The helper hands back up to a few hundred elements. Most of them are
 * structural — groups holding stack views, scroll areas wrapping scroll areas —
 * and no instruction a person gives ever refers to one. Handing all of them to
 * a model wastes the context the screenshot needs and, worse, gives it more
 * chances to name the wrong thing.
 *
 * So elements are scored, cut to a budget, and then put back into reading
 * order. Reading order is the important half: the model is looking at a
 * screenshot at the same time, and a list ordered by score would not correspond
 * to anything it can see. Ids survive the sort untouched, because the id is the
 * key and the position is not.
 */

import type { Rect, ScreenElement } from "./types.ts";

/** Roles a person actually points at. */
const INTERACTIVE = new Set([
  "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
  "AXMenuItem", "AXMenuBarItem", "AXTextField", "AXTextArea", "AXSearchField",
  "AXSecureTextField", "AXComboBox", "AXSlider", "AXLink", "AXTab",
  "AXDisclosureTriangle", "AXSwitch", "AXIncrementor", "AXStepper", "AXColorWell",
]);

/** Roles that exist to hold other things. Kept, but never preferred. */
const STRUCTURAL = new Set([
  "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem",
  "AXWindow", "AXToolbar", "AXTabGroup", "AXSplitter", "AXUnknown",
]);

/** Roles whose rows and cells are legitimately clickable. */
const COLLECTION = new Set(["AXRow", "AXCell", "AXList", "AXTable", "AXOutline", "AXStaticText"]);

export function centreOf(frame: Rect): { x: number; y: number } {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

export function area(frame: Rect): number {
  return Math.max(0, frame.width) * Math.max(0, frame.height);
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - 1
    && inner.y >= outer.y - 1
    && inner.x + inner.width <= outer.x + outer.width + 1
    && inner.y + inner.height <= outer.y + outer.height + 1
  );
}

/**
 * How much this element is worth showing the model.
 *
 * The weights are not tuned to a benchmark; each one is a statement about what
 * an instruction refers to. A named button inside the window you are looking at
 * is what people talk about. A 1400×900 unnamed group is not.
 */
export function scoreElement(element: ScreenElement, windowFrame?: Rect): number {
  let score = 0;

  if (INTERACTIVE.has(element.role)) score += 5;
  else if (COLLECTION.has(element.role)) score += 2;
  else if (STRUCTURAL.has(element.role)) score -= 2;

  // An element that can be pressed is an element that can be instructed.
  if (element.actions.some((action) => action === "AXPress" || action === "AXConfirm")) score += 2;

  if (element.label) score += 3;
  else score -= 4;

  // Disabled elements stay in the inventory: "that button is greyed out" is a
  // genuinely useful answer, and it cannot be given by an assistant that was
  // never shown the button.
  if (!element.enabled) score -= 2;
  if (element.focused) score += 2;

  if (windowFrame) {
    if (contains(windowFrame, element.frame)) score += 3;
    const windowArea = area(windowFrame);
    // Anything covering most of the window is scaffolding, whatever its role.
    if (windowArea > 0 && area(element.frame) > windowArea * 0.6) score -= 4;
  }

  // A control smaller than a few points cannot be aimed at reliably.
  if (element.frame.width < 4 || element.frame.height < 4) score -= 5;

  // Leaves are specific; the first two levels are the app and its window.
  if (element.depth >= 2 && element.depth <= 14) score += 1;

  return score;
}

/** Reading order: top to bottom, then left to right, with a row tolerance. */
function readingOrder(a: ScreenElement, b: ScreenElement): number {
  const rowDelta = a.frame.y - b.frame.y;
  if (Math.abs(rowDelta) > 12) return rowDelta;
  return a.frame.x - b.frame.x;
}

export interface RankOptions {
  windowFrame?: Rect;
  limit?: number;
}

/**
 * Scores, cuts to the budget, and returns the survivors in reading order.
 */
export function rankElements(elements: ScreenElement[], options: RankOptions = {}): ScreenElement[] {
  const limit = Math.max(1, options.limit ?? 60);
  const scored = elements.map((element, index) => ({ element, index, score: scoreElement(element, options.windowFrame) }));
  // Stable by original index on a tie, so the same screen always produces the
  // same inventory — a plan that is reproducible is a plan that is debuggable.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored
    .slice(0, limit)
    .map((entry) => entry.element)
    .sort(readingOrder);
}

function collapse(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

/**
 * One line per element, in the form the model answers in.
 *
 * The id leads because the id is what comes back. Everything after it is there
 * to let a person's words be matched to a row: what it is, what it says, where
 * it sits, and whether it can be used at all.
 */
export function describeElement(element: ScreenElement): string {
  const role = element.role.replace(/^AX/, "");
  const parts = [`${element.id}`, role];
  if (element.label) parts.push(`"${collapse(element.label, 70)}"`);
  if (element.value && element.value !== element.label) parts.push(`value="${collapse(element.value, 40)}"`);
  if (!element.enabled) parts.push("disabled");
  if (element.focused) parts.push("focused");
  const { x, y } = centreOf(element.frame);
  // The position is written for the operator reading a transcript, and to let
  // the model say "the one on the right". It is never read back out of a plan.
  parts.push(`at ${Math.round(x)},${Math.round(y)}`);
  if (element.path) parts.push(`in ${collapse(element.path, 60)}`);
  return parts.join("  ");
}

export function inventoryText(elements: ScreenElement[]): string {
  return elements.map(describeElement).join("\n");
}

/** Index by id, for resolving a plan step back to the frame the OS reported. */
export function indexElements(elements: ScreenElement[]): Map<string, ScreenElement> {
  return new Map(elements.map((element) => [element.id, element]));
}
