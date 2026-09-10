import React from "react";
import { FolderLock } from "lucide-react";
import { SettingGroup, SettingList, SettingRow, SettingSelect, SettingToggle } from "../ui/Setting";
import { useStudioStore } from "../../store/studioStore";
import type { RunMode } from "../../services/preferences";

/**
 * Agents.
 *
 * The screen that decides how much runs on this machine without a human
 * looking, so it is the one place in settings where a row that overstates its
 * backing is not merely untidy. Cursor's Agents screen carries seventeen rows;
 * this carries the five we can actually honour, and
 * `docs/SETTINGS_AND_CHROME_PLAN.md` §3 names the twelve that were measured out
 * and what each would need to come back.
 *
 * Two absences are worth knowing here rather than only in the plan. There is no
 * **sandbox** run mode, because there is no sandbox: commands run against the
 * real filesystem with the app's own privileges, and a mode named for
 * containment we do not have would be the most dangerous label on the screen.
 * And there is no **queue** for messages sent mid-turn — the composer
 * interrupts, always — so the two rows Cursor spends on that choice would be a
 * choice between one behaviour and itself.
 */

const RUN_MODE_COPY: Record<RunMode, string> = {
  ask: "Every command waits for you, including the read-only ones. Slowest, and the only mode where nothing at all runs unseen.",
  review:
    "Reading and inspection run straight away; anything that writes, installs or deletes waits for you. This is the default.",
  auto: "Anything the classifier does not refuse outright runs unattended. Use it for a task you are watching, not one you have walked away from.",
};

export const AgentsPane: React.FC = () => {
  const preferences = useStudioStore((state) => state.preferences);
  const setPreferences = useStudioStore((state) => state.setPreferences);

  /* The deletion guard is real only in `auto` — in the other two modes a delete
     is a state-changing command and already stops for a human. The row stays
     live rather than disabled, because the preference is the operator's standing
     intent and outlives the mode they are in this minute; what would be
     dishonest is letting it read as though it were doing something today. */
  const guardIdle = preferences.runMode !== "auto";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-bright">Agents</h1>
        <p className="mt-1 text-xs text-ink-muted">
          What an agent may do on this machine before you see it.
        </p>
      </div>

      <SettingGroup
        label="Execution"
        description="Every command an agent proposes is classified first. A command judged destructive beyond recovery — privilege escalation, a disk-level write, a force push — is refused in all three modes and is not offered for approval."
      >
        <SettingRow label="Run Mode" description={RUN_MODE_COPY[preferences.runMode]}>
          <SettingSelect
            value={preferences.runMode}
            aria-label="Run mode"
            onChange={(event) => setPreferences({ runMode: event.target.value as RunMode })}
          >
            <option value="ask">Ask every time</option>
            <option value="review">Review changes</option>
            <option value="auto">Run without asking</option>
          </SettingSelect>
        </SettingRow>

        <SettingRow
          label="Always Ask Before Deleting"
          description={
            guardIdle
              ? "Deleting already waits for you in this mode. The setting is kept for when you switch to “Run without asking”, where it is the one exception that still stops."
              : "Deletes stop for you even though everything else is running unattended. A bad edit is in the change dock and in git; a deleted file is in neither."
          }
          className={guardIdle ? undefined : "bg-warning/5"}
        >
          <SettingToggle
            checked={preferences.protectDeletions}
            onChange={(protectDeletions) => setPreferences({ protectDeletions })}
            label="Always ask before deleting"
          />
        </SettingRow>

        {/* ── A guarantee, not a switch ──────────────────────────────────
            Cursor offers External-File Protection as a toggle. Ours is not a
            preference: `server/workspace.js` resolves every path against the
            workspace root and throws WORKSPACE_PATH_ESCAPE if it lands outside,
            on read, write and delete alike, with no way to ask it not to. A
            toggle would either do nothing or offer to remove the guarantee. The
            second half of this row is the part an operator actually needs,
            because it is where the boundary stops. */}
        <SettingRow
          label={
            <span className="flex items-center gap-1.5 font-semibold text-ink-bright">
              <FolderLock size={14} className="text-ink-muted" />
              File edits cannot leave the workspace
            </span>
          }
          description={
            <>
              <span className="block">
                The file tools resolve every path against the workspace root and refuse anything that
                resolves outside it, symlinks included. That is enforced in the server, not here, and
                there is no setting that relaxes it.
              </span>
              <span className="mt-1.5 block">
                Shell commands are a different matter: they are handed to a shell, which has the whole
                filesystem and your own privileges. Nothing bounds a command to the workspace — Run Mode
                above is what stands between an agent and the rest of the disk.
              </span>
            </>
          }
        />
      </SettingGroup>

      <SettingGroup
        label="Approvals"
        description="Answering a prompt with “Always allow” adds what it covers here. It used to be forgotten when the window closed; now it is kept, which only makes sense if you can also see and undo it."
      >
        <SettingRow
          label="Allowed Without Asking"
          description="One executable or tool per entry — the first word of a command, so allowing “npm” allows every npm command and nothing else. These skip the prompt in every run mode. Deletions still stop while the guard above is on."
        />
        <SettingList
          entries={preferences.commandAllowlist}
          onChange={(commandAllowlist) => setPreferences({ commandAllowlist })}
          placeholder="npm"
          label="Add an allowed executable"
          emptyNote="Nothing is allowed without asking. Every command that changes something will stop for you."
          validate={(entry) =>
            /\s/.test(entry) ? "One executable per entry — no spaces or arguments." : null
          }
        />
      </SettingGroup>

      <SettingGroup label="Composer">
        <SettingRow
          label="Submit with ⌘+Enter"
          description="Send with ⌘/Ctrl+Return and leave a bare Return for a new line. Off, Return sends and Shift+Return breaks the line. Shift+Return never sends either way."
        >
          <SettingToggle
            checked={preferences.submitWithModEnter}
            onChange={(submitWithModEnter) => setPreferences({ submitWithModEnter })}
            label="Submit with Command and Enter"
          />
        </SettingRow>
      </SettingGroup>
    </div>
  );
};

/** The row labels this pane carries, for the settings rail's search. */
export const AGENTS_ROWS = [
  "Run Mode",
  "Always Ask Before Deleting",
  "File edits cannot leave the workspace",
  "Allowed Without Asking",
  "Submit with ⌘+Enter",
];
