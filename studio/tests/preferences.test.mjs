/**
 * Preferences, and the two rules the settings rows depend on.
 *
 * The Notifications rows on Settings > General were deleted once already, in a
 * January audit, as controls with nothing behind them. What makes them honest
 * this time is a chain of three small decisions — which turn just ended, how it
 * ended, and whether that outcome is one the operator asked to hear about — and
 * every link of that chain is pure, so it is pinned here rather than left to be
 * discovered on screen.
 *
 * `announceTurn` itself is not tested: it posts an OS notification and drives
 * WebAudio, neither of which exists under `node --test`. The gates it consults
 * are all below.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PREFERENCES,
  applyPreferences,
  currentPreferences,
  normalizeHiddenProfiles,
  normalizePreferences,
  preferredName,
  visibleModelProfiles,
} from "../src/services/preferences.ts";
import { classifyTurn, latestSettledTurn, shouldNotify } from "../src/services/notifications.ts";
import { parseLink } from "../src/services/linkOpen.ts";

const turn = (id, fields = {}) => ({
  id,
  role: "assistant",
  content: "",
  timestamp: "04:00",
  ...fields,
});

test("an older persisted shape is healed, not trusted", () => {
  const healed = normalizePreferences({ completionSound: true });
  assert.equal(healed.completionSound, true);
  // Everything the older build did not know about comes from the defaults.
  assert.equal(healed.restoreSession, DEFAULT_PREFERENCES.restoreSession);
  assert.equal(healed.linkDestination, DEFAULT_PREFERENCES.linkDestination);
});

test("a link destination the build does not know falls back rather than sticking", () => {
  assert.equal(normalizePreferences({ linkDestination: "carrier-pigeon" }).linkDestination, "in-app");
});

test("a display name is trimmed and bounded", () => {
  assert.equal(normalizePreferences({ displayName: "  Yohana  " }).displayName, "Yohana");
  assert.equal(normalizePreferences({ displayName: "x".repeat(400) }).displayName.length, 64);
});

test("applying publishes the settled shape for callers with no store", () => {
  applyPreferences({ linkDestination: "system", displayName: " Temi " });
  assert.equal(currentPreferences().linkDestination, "system");
  assert.equal(currentPreferences().displayName, "Temi");
  applyPreferences(DEFAULT_PREFERENCES);
  assert.equal(currentPreferences().linkDestination, "in-app");
});

test("the chosen name wins, then GitHub's, then nothing", () => {
  applyPreferences({ displayName: "Temi" });
  assert.equal(preferredName({ name: "Yohana Gitau", login: "teminali" }), "Temi");
  applyPreferences(DEFAULT_PREFERENCES);
  assert.equal(preferredName({ name: "Yohana Gitau", login: "teminali" }), "Yohana Gitau");
  assert.equal(preferredName({ name: null, login: "teminali" }), "teminali");
  // Never a placeholder: a caller can drop the name, and "friend" reads worse.
  assert.equal(preferredName(null), null);
});

test("the turn that just ended is the newest assistant message across the engines", () => {
  const found = latestSettledTurn([
    [turn("msg_1000_aa")],
    [turn("msg_3000_bb")],
    [turn("msg_2000_cc")],
    [],
  ]);
  assert.equal(found.id, "msg_3000_bb");
});

test("a transcript ending on the operator's own message is not a settled turn", () => {
  const found = latestSettledTurn([
    [turn("msg_5000_aa", { role: "user" })],
    [turn("msg_1000_bb")],
  ]);
  assert.equal(found.id, "msg_1000_bb");
  assert.equal(latestSettledTurn([[], undefined, [turn("msg_9_z", { role: "user" })]]), null);
});

test("an outcome is read off the message, which the call sites finalise first", () => {
  assert.equal(classifyTurn(turn("msg_1_a")), "completed");
  assert.equal(classifyTurn(turn("msg_1_a", { errorCode: "ECONNREFUSED" })), "failed");
  assert.equal(classifyTurn(turn("msg_1_a", { cancelled: true })), "cancelled");
  assert.equal(classifyTurn(null), null);
});

test("a turn the operator cancelled never notifies — they were there", () => {
  const all = { ...DEFAULT_PREFERENCES, notifyTurnComplete: true, notifyTurnFailed: true };
  assert.equal(shouldNotify("cancelled", all), false);
  assert.equal(shouldNotify("completed", all), true);
  assert.equal(shouldNotify("failed", all), true);
  assert.equal(shouldNotify(null, all), false);
});

test("each notification row gates only its own outcome", () => {
  const quietSuccess = { ...DEFAULT_PREFERENCES, notifyTurnComplete: false, notifyTurnFailed: true };
  assert.equal(shouldNotify("completed", quietSuccess), false);
  assert.equal(shouldNotify("failed", quietSuccess), true);
});

test("only http, https and mailto leave through the one door", () => {
  assert.equal(parseLink("https://teminali.dev").href, "https://teminali.dev/");
  assert.ok(parseLink("mailto:hi@teminali.dev"));
  // A link in a chat answer is text a model produced.
  assert.equal(parseLink("javascript:alert(1)"), null);
  assert.equal(parseLink("file:///etc/passwd"), null);
  assert.equal(parseLink("not a url at all"), null);
});

/* ── Which models the composer's picker offers ───────────────────────────────
   The hidden set is stored, so it is the shape that survives a bad write; the
   visibility rule is what the menu is actually built from. Both are pinned
   because the second one has a clause that looks removable and is not. */

test("a hidden set from a stranger keeps only ids this build knows", () => {
  assert.deepEqual(normalizeHiddenProfiles(["max", "gpt-9", "max", 7, null]), ["max"]);
  // Not an array at all — an older build, or a hand-edited file.
  assert.deepEqual(normalizeHiddenProfiles(undefined), []);
  assert.deepEqual(normalizeHiddenProfiles("max"), []);
});

test("nothing is hidden until the operator hides it", () => {
  assert.deepEqual(DEFAULT_PREFERENCES.hiddenModelProfiles, []);
  // A shape persisted before this preference existed gains the empty set, not
  // a set that withholds the models that build could not name.
  assert.deepEqual(normalizePreferences({ completionSound: true }).hiddenModelProfiles, []);
});

test("the picker offers what is not hidden", () => {
  const profiles = [{ id: "flash" }, { id: "auto" }, { id: "max" }, { id: "gemini" }];
  const shown = visibleModelProfiles(profiles, ["max", "gemini"], "flash");
  assert.deepEqual(shown.map((profile) => profile.id), ["flash", "auto"]);
});

test("the picker always names the profile it is running, hidden or not", () => {
  // CommandPaletteModal and GeminiKeyModal both call setProfile without asking
  // this list, so the active profile really can be a hidden one.
  const profiles = [{ id: "flash" }, { id: "auto" }, { id: "max" }, { id: "gemini" }];
  const shown = visibleModelProfiles(profiles, ["flash", "auto", "max", "gemini"], "max");
  assert.deepEqual(shown.map((profile) => profile.id), ["max"]);
});
