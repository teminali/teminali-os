/**
 * Preferences — the settings that change what the shell *does*, as opposed to
 * how it looks.
 *
 * Appearance is a sibling of this module and the two are deliberately apart:
 * `appearance.ts` writes CSS custom properties onto the document, so its whole
 * job is finished the moment it is applied. Nothing here can be written onto
 * the document. A preference like "open links in the in-app browser" is not a
 * property of the page — it is a rule that has to be read at the instant a
 * link is clicked, by code that may be nowhere near a React tree.
 *
 * So this module publishes the settled preferences into module scope, and
 * `currentPreferences()` is how a non-React caller reaches them. The store
 * still holds the intent; `applyPreferences` makes it reachable. Same contract
 * as `applyAppearance`, different mechanism, for the reason above.
 *
 * Everything declared here is backed by something that actually happens. A
 * preference for a capability we do not have is a lie in the interface, and
 * `DESIGN.md` §3 records which of Cursor's rows were
 * rejected on exactly that ground.
 */

import type { ModelProfileId } from "../types";

/** Where a link clicked inside the app opens. */
export type LinkDestination = "in-app" | "system";

/**
 * How much the agent may run without stopping to ask.
 *
 * Named for what happens, not for a safety level: there is no sandbox here and
 * a mode called one would be the interface lying about where commands run.
 * `services/agentCommands.ts` classifies every command as auto, confirm or
 * blocked; these three modes decide what to do with the first two, and nothing
 * moves the third — blocked is refused in every mode.
 */
export type RunMode = "ask" | "review" | "auto";

export interface Preferences {
  /**
   * Reopen the workspace you left — editor tabs, the active chat, the settings
   * pane you had open — or start clean.
   *
   * This is the workspace, not the window: the shell does not persist its own
   * bounds yet, so size and position are the host's business either way. The
   * row says so rather than implying a restore that does not happen.
   */
  restoreSession: boolean;
  /** Post a system notification when an agent turn finishes cleanly. */
  notifyTurnComplete: boolean;
  /** Post a system notification when an agent turn ends in an error. */
  notifyTurnFailed: boolean;
  /** Play a short chime when a turn finishes, however it finished. */
  completionSound: boolean;
  /**
   * Keep the assistant's item in the menu bar.
   *
   * The one preference here the renderer cannot honour on its own: macOS has no
   * way to hide a `Tray`, so off destroys the item and on builds it again, both
   * in the main process. What comes back is the settled state rather than the
   * request — a platform with no tray at all must not leave this reading true.
   */
  menuBarIcon: boolean;
  /**
   * What the app calls you. Empty means "use the GitHub identity", which is
   * why the default is empty rather than a name: an invented default would be
   * indistinguishable from a name you had chosen.
   */
  displayName: string;
  /** In-app browser panel, or hand off to the system browser. */
  linkDestination: LinkDestination;
  /** How much an agent may run before a human sees it. */
  runMode: RunMode;
  /**
   * Keep deletions asking even in `auto`.
   *
   * The one exception the auto mode carries, and the reason it can be offered
   * at all: everything else an agent does in auto is recoverable from the
   * change dock or from git, and a delete is the one that is not.
   */
  protectDeletions: boolean;
  /**
   * Executables and tool names answered with "always allow", kept across
   * restarts.
   *
   * The gate has always remembered these; it forgot them when the window
   * closed and there was nowhere to see or undo one. Entries are what
   * `commandHead` produces — the first word of a command, or a whole
   * `mcp__server__tool` name.
   */
  commandAllowlist: string[];
  /** Require ⌘/Ctrl with Return to send, leaving a bare Return for newlines. */
  submitWithModEnter: boolean;
  /**
   * Frontier profiles kept out of the composer's model picker.
   *
   * Stored as what is *hidden* rather than what is shown, so a profile a later
   * build adds arrives on the menu of an operator who never saw it. A shown-list
   * would withhold every future model from every existing install, silently.
   *
   * The picker still renders the profile it is currently on even when this list
   * names it. `CommandPaletteModal` and `GeminiKeyModal` both call `setProfile`
   * without consulting the list, so a hidden profile can become the active one,
   * and a menu that could not name what it was running would be a worse lie
   * than one row too many.
   */
  hiddenModelProfiles: ModelProfileId[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  restoreSession: true,
  notifyTurnComplete: true,
  notifyTurnFailed: true,
  completionSound: false,
  menuBarIcon: true,
  displayName: "",
  linkDestination: "in-app",
  runMode: "review",
  protectDeletions: true,
  commandAllowlist: [],
  submitWithModEnter: false,
  hiddenModelProfiles: [],
};

const LINK_DESTINATIONS: LinkDestination[] = ["in-app", "system"];
const RUN_MODES: RunMode[] = ["ask", "review", "auto"];

/** A display name longer than this is a paste accident, not a name. */
const MAX_DISPLAY_NAME = 64;

/**
 * Bounds on the allowlist. An entry is one executable or tool name, so
 * anything with whitespace in it arrived from a paste and would never match
 * `commandHead` anyway; the ceiling keeps a runaway "always" from growing a
 * list nobody can audit, which is the only thing that makes the list dangerous.
 */
const MAX_ALLOWLIST_ENTRY = 80;
const MAX_ALLOWLIST = 200;

/** The allowlist as it is stored: trimmed, single words, unique, bounded. */
export const normalizeAllowlist = (entries?: unknown): string[] => {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = String(entry ?? "").trim().slice(0, MAX_ALLOWLIST_ENTRY);
    if (!value || /\s/.test(value)) continue;
    seen.add(value);
    if (seen.size >= MAX_ALLOWLIST) break;
  }
  return [...seen];
};

/**
 * Every profile the picker can offer.
 *
 * A `Record` rather than an array so a fifth id in `ModelProfileId` fails to
 * compile here, instead of quietly normalising itself out of every operator's
 * stored preferences.
 */
const MODEL_PROFILES: Record<ModelProfileId, true> = {
  flash: true,
  auto: true,
  max: true,
};

/** The hidden set as it is stored: ids this build knows, each at most once. */
export const normalizeHiddenProfiles = (entries?: unknown): ModelProfileId[] => {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<ModelProfileId>();
  for (const entry of entries) {
    if (typeof entry === "string" && entry in MODEL_PROFILES) seen.add(entry as ModelProfileId);
  }
  return [...seen];
};

/**
 * The profiles a picker should offer: everything not hidden, plus the one in
 * use whether it is hidden or not.
 *
 * That second clause is not defensive programming, it is a measured case.
 * `CommandPaletteModal` selects `auto` and `flash`, and `GeminiKeyModal`
 * selects `max`, none of them consulting this list — so the active profile can
 * be one the operator hid, and a menu that could not name what it was running
 * would be a worse lie than one row too many. It lives here rather than in the
 * picker so the rule can be pinned by a test that needs no DOM.
 */
export const visibleModelProfiles = <T extends { id: ModelProfileId }>(
  profiles: readonly T[],
  hidden: readonly ModelProfileId[],
  current: ModelProfileId,
): T[] => profiles.filter((profile) => !hidden.includes(profile.id) || profile.id === current);

/** Fill in anything a persisted older shape is missing, and bound the strings. */
export const normalizePreferences = (partial?: Partial<Preferences>): Preferences => {
  const merged = { ...DEFAULT_PREFERENCES, ...(partial ?? {}) };
  return {
    restoreSession: Boolean(merged.restoreSession),
    notifyTurnComplete: Boolean(merged.notifyTurnComplete),
    notifyTurnFailed: Boolean(merged.notifyTurnFailed),
    completionSound: Boolean(merged.completionSound),
    menuBarIcon: Boolean(merged.menuBarIcon),
    displayName: String(merged.displayName ?? "").trim().slice(0, MAX_DISPLAY_NAME),
    linkDestination: LINK_DESTINATIONS.includes(merged.linkDestination)
      ? merged.linkDestination
      : DEFAULT_PREFERENCES.linkDestination,
    runMode: RUN_MODES.includes(merged.runMode) ? merged.runMode : DEFAULT_PREFERENCES.runMode,
    protectDeletions: Boolean(merged.protectDeletions),
    commandAllowlist: normalizeAllowlist(merged.commandAllowlist),
    submitWithModEnter: Boolean(merged.submitWithModEnter),
    hiddenModelProfiles: normalizeHiddenProfiles(merged.hiddenModelProfiles),
  };
};

let settled: Preferences = DEFAULT_PREFERENCES;

/**
 * Settle the preferences and publish them for non-React callers.
 *
 * Idempotent and cheap, so the store may call it on every change. It returns
 * the normalised shape, which is what the store keeps — the same trick
 * `applyAppearance` uses to heal a slice persisted by an older build.
 */
export const applyPreferences = (partial?: Partial<Preferences>): Preferences => {
  settled = normalizePreferences(partial);
  return settled;
};

/** The settled preferences, for code that has no store and no hooks. */
export const currentPreferences = (): Preferences => settled;

/**
 * The two preferences the command runner needs, shaped as its options.
 *
 * It exists so the engine can spread one call at each `runAgentCommands` site
 * instead of reaching into preferences twice per site and drifting apart. Read
 * at the moment of the call, never captured: a turn that started before the
 * operator tightened the mode should tighten with it, not finish under the old
 * one.
 */
export const commandPolicy = (): { runMode: RunMode; protectDeletions: boolean } => ({
  runMode: settled.runMode,
  protectDeletions: settled.protectDeletions,
});

/**
 * What to call the operator: their own choice first, then the GitHub identity,
 * then nothing.
 *
 * Returning `null` rather than "there" or "friend" is deliberate. A greeting
 * with a placeholder name in it reads worse than a greeting with no name, and
 * every caller here can drop the name entirely.
 */
export const preferredName = (
  identity?: { name?: string | null; login?: string | null } | null,
): string | null => {
  const chosen = settled.displayName.trim();
  if (chosen) return chosen;
  const given = identity?.name?.trim();
  if (given) return given;
  const login = identity?.login?.trim();
  return login || null;
};
