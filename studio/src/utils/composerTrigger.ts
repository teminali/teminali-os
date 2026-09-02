/**
 * The composer's `/` and `@` trigger logic.
 *
 * Pure, and deliberately outside the component that renders the menu: these two
 * rules decide whether the feature feels like an editor or like a menu that
 * keeps interrupting you, so they are the part worth testing — and a .tsx file
 * cannot be imported by the node test runner.
 */

export type TriggerKind = "skill" | "file";

export interface ComposerMenuItem {
  id: string;
  label: string;
  detail?: string;
  kind: TriggerKind;
}

export interface ActiveTrigger {
  kind: TriggerKind;
  /** Index of the trigger character in the textarea's value. */
  at: number;
  /** What has been typed after it. */
  query: string;
}

export function readTrigger(value: string, caret: number): ActiveTrigger | null {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const character = value[index];
    if (character === "\n" || character === " ") return null;
    if (character !== "/" && character !== "@") continue;

    // A word boundary: start of input, or preceded by whitespace. `src/App` and
    // `user@host` are therefore not triggers.
    const preceding = index === 0 ? "" : value[index - 1];
    if (preceding !== "" && !/\s/.test(preceding)) return null;

    return {
      kind: character === "/" ? "skill" : "file",
      at: index,
      query: value.slice(index + 1, caret),
    };
  }
  return null;
}

export function scoreMatch(candidate: string, query: string): number | null {
  if (!query) return 0;
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let cursor = 0;
  let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    if (found === previous + 1) score += 3;
    if (found === 0 || "/-_. ".includes(haystack[found - 1] ?? "")) score += 2;
    previous = found;
    cursor = found + 1;
  }
  // Shorter candidates are likelier to be what was meant.
  return score - candidate.length * 0.01;
}
