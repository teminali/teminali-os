/**
 * System notifications for a finished agent turn, and the chime that goes with
 * them.
 *
 * ## Why this exists at all
 *
 * A long turn is the one moment the operator leaves the window. Until now the
 * app had no way to tell them it was done — there is no `new Notification` and
 * no audio anywhere in `src/` outside the video engine — so the Notifications
 * rows on the settings screen are new capability, not a restored switch. A
 * January audit deleted the old "Completion Sound" row precisely because it
 * was a control with nothing behind it; putting it back without building the
 * sound would have earned the same deletion.
 *
 * ## Two rules the rows depend on
 *
 * **A notification only fires when the window is not focused.** Telling
 * somebody that the thing they are watching has happened is noise, and noise
 * is how a notification permission gets revoked. The row's description says
 * this outright, so the toggle is not silently narrower than it reads.
 *
 * **The chime is not subject to that rule.** It is off by default, and
 * somebody who turns it on is asking to hear the end of a turn whether or not
 * they are looking at it. Bounding it by focus would make it inaudible in
 * exactly the case it was enabled for.
 *
 * ## Why the outcome is classified here rather than at the call sites
 *
 * `setStreaming(false)` is called from eleven places across three components,
 * all of them on the streaming path — the single most load-bearing path in the
 * app. Threading an outcome argument through all eleven would put an edit on
 * every one of them to serve a settings row. Instead the store calls
 * `latestSettledTurn` at the one place the flag falls, and the message it
 * finds already carries its own verdict: the call sites set `errorCode` and
 * `cancelled` on the message *before* they clear the streaming flag.
 */

import type { ChatMessage } from "../types";
import { currentPreferences } from "./preferences.ts";

/** What became of the turn that just ended. */
export type TurnOutcome = "completed" | "failed" | "cancelled";

/**
 * The engine message lists, newest turn last. The store passes all four
 * because which one is live depends on which component was streaming, and the
 * store does not track that — see the module note.
 */
export type EngineTranscripts = Array<ChatMessage[] | undefined>;

/**
 * When a message was made, from its id.
 *
 * Ids are minted as `msg_${Date.now()}_${rand}`, which is the only
 * millisecond-accurate stamp a message carries: `timestamp` is a localised
 * hour and minute, so two turns in the same minute are indistinguishable by
 * it. A message whose id predates that scheme sorts to the bottom rather than
 * throwing, because an unparseable id is an old message, not a broken one.
 */
const mintedAt = (message: ChatMessage): number => {
  const match = /^msg_(\d+)_/.exec(message.id);
  return match ? Number(match[1]) : 0;
};

/**
 * The assistant turn that just finished, across every engine transcript.
 *
 * The last message of each list is the only candidate — a turn settles at the
 * end of its own transcript — and the newest of those candidates wins.
 */
export const latestSettledTurn = (transcripts: EngineTranscripts): ChatMessage | null => {
  let newest: ChatMessage | null = null;
  for (const list of transcripts) {
    const last = list && list.length > 0 ? list[list.length - 1] : null;
    if (!last || last.role !== "assistant") continue;
    if (!newest || mintedAt(last) >= mintedAt(newest)) newest = last;
  }
  return newest;
};

/**
 * How a settled turn ended.
 *
 * `cancelled` is its own answer and not a failure: the operator stopped it, so
 * they already know, and neither notification fires for it.
 */
export const classifyTurn = (message: ChatMessage | null): TurnOutcome | null => {
  if (!message) return null;
  if (message.cancelled) return "cancelled";
  return message.errorCode ? "failed" : "completed";
};

/** Whether the OS will actually deliver a notification we post. */
export type NotificationPermission = "granted" | "denied" | "default" | "unsupported";

export const notificationPermission = (): NotificationPermission => {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission as NotificationPermission;
};

/**
 * Ask for the permission, once, from a click.
 *
 * The settings row asks rather than the app asking on launch: a permission
 * prompt at startup, before the operator has seen a single notification, is
 * the one most reliably denied — and a denied permission is not recoverable
 * from inside the app on any platform.
 */
export const requestNotificationPermission = async (): Promise<NotificationPermission> => {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    return (await window.Notification.requestPermission()) as NotificationPermission;
  } catch {
    return notificationPermission();
  }
};

/**
 * Two soft notes, a major third apart, on a short exponential decay.
 *
 * Synthesised rather than shipped as an asset: a completion chime is four
 * oscillator calls, and a bundled `.wav` would be the only audio asset in the
 * app and the only one that has to be licence-cleared for redistribution.
 */
const chime = () => {
  const Ctor: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  let context: AudioContext;
  try {
    context = new Ctor();
  } catch {
    return;
  }
  const now = context.currentTime;
  [880, 1108.73].forEach((frequency, index) => {
    const at = now + index * 0.09;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    // Ramped, never stepped: a gain that jumps to its value clicks.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.3);
  });
  // Let the notes finish, then release the hardware.
  window.setTimeout(() => void context.close().catch(() => {}), 800);
};

/** Whether a notification for this outcome should be posted at all. */
export const shouldNotify = (
  outcome: TurnOutcome | null,
  preferences = currentPreferences(),
): boolean => {
  if (outcome === "completed") return preferences.notifyTurnComplete;
  if (outcome === "failed") return preferences.notifyTurnFailed;
  return false;
};

const COPY: Record<"completed" | "failed", { title: string; body: string }> = {
  completed: { title: "Turn complete", body: "The agent finished and is waiting for you." },
  failed: { title: "Turn failed", body: "The agent stopped on an error." },
};

/**
 * Announce a settled turn. Safe to call for any outcome, including none — the
 * store calls it unconditionally and every gate lives here, so the rules stay
 * in one readable place instead of spread across the streaming path.
 */
export const announceTurn = (message: ChatMessage | null): void => {
  const outcome = classifyTurn(message);
  if (!outcome) return;
  const preferences = currentPreferences();

  if (preferences.completionSound && outcome !== "cancelled") chime();

  if (!shouldNotify(outcome, preferences)) return;
  if (notificationPermission() !== "granted") return;
  // The window is right there; a notification about it would be noise.
  if (typeof document !== "undefined" && document.hasFocus()) return;

  const copy = COPY[outcome as "completed" | "failed"];
  try {
    // eslint-disable-next-line no-new -- the handle is not ours to hold; the OS owns the lifetime.
    new window.Notification(copy.title, { body: copy.body, silent: preferences.completionSound });
  } catch {
    /* A platform that refuses the constructor is a platform with no
       notifications. The toggle stays honest because the permission row on the
       settings screen reports `unsupported` for exactly this case. */
  }
};
