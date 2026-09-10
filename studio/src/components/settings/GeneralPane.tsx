import React, { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { SettingGroup, SettingRow, SettingToggle } from "../ui/Setting";
import { useStudioStore } from "../../store/studioStore";
import {
  notificationPermission,
  requestNotificationPermission,
  type NotificationPermission,
} from "../../services/notifications";

/**
 * General.
 *
 * Three of the rows here were deleted in a January audit as controls with
 * nothing behind them — Window Restoration, System Notifications, Completion
 * Sound. They are back because the capability now exists, not because the row
 * looked useful: `services/notifications.ts` posts the notification and
 * synthesises the chime, and the store honours the restore preference when it
 * rehydrates. A row whose backing was still missing stayed out, and
 * `docs/SETTINGS_AND_CHROME_PLAN.md` §3 names which and why.
 *
 * The privacy card is the one thing on this screen that is a statement rather
 * than a control, deliberately. Cursor has a Data Sharing switch; we collect
 * nothing, and offering a switch would imply there is something to switch off.
 */

const PERMISSION_COPY: Record<NotificationPermission, string> = {
  granted: "This machine will deliver them.",
  denied:
    "This machine is refusing them. No app can undo that from the inside — it has to be re-allowed in system settings.",
  default: "Not asked for yet. Nothing will be delivered until it is.",
  unsupported: "This build has no notification service to post to.",
};

export const GeneralPane: React.FC = () => {
  const preferences = useStudioStore((state) => state.preferences);
  const setPreferences = useStudioStore((state) => state.setPreferences);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  /* A browser build has no menu bar item to keep, so that row is absent rather
     than disabled. A switch for a capability the build does not have is exactly
     what `docs/SETTINGS_AND_CHROME_PLAN.md` §3 rejects rows for. */
  const [hasMenuBar] = useState(
    () => typeof window !== "undefined" && Boolean(window.teminali?.assistant?.setTrayVisible),
  );

  useEffect(() => setPermission(notificationPermission()), []);

  const ask = useCallback(async () => {
    setPermission(await requestNotificationPermission());
  }, []);

  /* The toggles above are not disabled when the permission is missing: the
     preference is the operator's intent and outlives a permission they may
     grant later. What would be dishonest is leaving them looking effective, so
     the row below reports the truth instead. */
  const undeliverable = permission !== "granted";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-bright">General</h1>
        <p className="mt-1 text-xs text-ink-muted">
          How the app starts, and how it gets your attention when you are somewhere else.
        </p>
      </div>

      <SettingGroup label="Startup">
        <SettingRow
          label="Restore Last Session"
          description="Reopen the editor tabs you had open. Off starts with a clean workspace — your chats are kept either way, because they are work rather than layout."
        >
          <SettingToggle
            checked={preferences.restoreSession}
            onChange={(restoreSession) => setPreferences({ restoreSession })}
            label="Restore last session"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        label="Notifications"
        description="A turn can run for minutes. These are how it reaches you once you have looked away."
      >
        <SettingRow
          label="Turn Complete"
          description="Notify when an agent finishes and is waiting for you. Only while the window is in the background — a notification about the window you are looking at is noise."
        >
          <SettingToggle
            checked={preferences.notifyTurnComplete}
            onChange={(notifyTurnComplete) => setPreferences({ notifyTurnComplete })}
            label="Notify on turn complete"
          />
        </SettingRow>
        <SettingRow
          label="Turn Failed"
          description="Notify when a turn stops on an error. A turn you cancelled yourself never notifies — you were there."
        >
          <SettingToggle
            checked={preferences.notifyTurnFailed}
            onChange={(notifyTurnFailed) => setPreferences({ notifyTurnFailed })}
            label="Notify on turn failed"
          />
        </SettingRow>
        <SettingRow
          label="Completion Sound"
          description="A two-note chime when a turn ends. Unlike the notifications this plays whether or not you are looking, which is the case it exists for."
        >
          <SettingToggle
            checked={preferences.completionSound}
            onChange={(completionSound) => setPreferences({ completionSound })}
            label="Completion sound"
          />
        </SettingRow>
        <SettingRow
          label="Notification Permission"
          description={PERMISSION_COPY[permission]}
          className={undeliverable ? "bg-warning/5" : undefined}
        >
          {permission === "default" ? (
            <button
              type="button"
              onClick={() => void ask()}
              className="rounded-md bg-accent px-2.5 py-1.5 text-2xs font-semibold text-accent-ink transition-colors duration-ds ease-ds hover:bg-accent-hover"
            >
              Allow notifications
            </button>
          ) : (
            <span
              className={`rounded-md border px-2 py-1 text-2xs font-medium ${
                permission === "granted"
                  ? "border-success/25 bg-success/10 text-success"
                  : "border-warning/25 bg-warning/10 text-warning"
              }`}
            >
              {permission === "granted" ? "Allowed" : permission === "denied" ? "Blocked" : "Unavailable"}
            </span>
          )}
        </SettingRow>
        {hasMenuBar && (
          <SettingRow
            label="Menu Bar Icon"
            description="Keep the assistant's item in the menu bar, showing its mode and whether it can see your screen. Turning it off removes the item only — the keyboard shortcut and the panel in the window both still work."
          >
            <SettingToggle
              checked={preferences.menuBarIcon}
              onChange={(menuBarIcon) => setPreferences({ menuBarIcon })}
              label="Menu bar icon"
            />
          </SettingRow>
        )}
      </SettingGroup>

      {/* ── Where a prompt actually goes ─────────────────────────────────
          This card used to claim "100% Local Execution · Zero Telemetry
          Exfiltration", unconditionally. It is not true: the Claude Code and
          Codex engines send prompt context to Anthropic and OpenAI, and the
          cloud lane sends it to its provider — that is what those engines are.
          The claim was the most load-bearing sentence on the screen and the
          only false one, and somebody could have chosen an engine on the
          strength of it. What is true is narrower and worth saying plainly. */}
      <SettingGroup label="Privacy">
        <SettingRow
          label={
            <span className="flex items-center gap-1.5 font-semibold text-ink-bright">
              <ShieldCheck size={14} className="text-ink-muted" />
              Where your code goes depends on the engine
            </span>
          }
          description={
            <>
              <span className="block">
                The local lane runs on this machine: prompts, file contents and edits reach Ollama over
                the loopback gateway and nothing else. The Claude Code, Codex and cloud lanes send prompt
                context — including the files they are asked to read — to their provider, because that is
                what those engines are.
              </span>
              <span className="mt-1.5 block">
                The app itself collects no analytics and phones nothing home. Its only unprompted
                outbound request is the update check, which asks the public GitHub releases API for a
                version number and sends nothing about you.
              </span>
            </>
          }
        />
      </SettingGroup>
    </div>
  );
};

/** The row labels this pane carries, for the settings rail's search. */
export const GENERAL_ROWS = [
  "Restore Last Session",
  "Turn Complete",
  "Turn Failed",
  "Completion Sound",
  "Notification Permission",
  "Menu Bar Icon",
  "Where your code goes depends on the engine",
];
