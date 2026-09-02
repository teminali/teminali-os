import React from "react";
import { Github, Settings } from "lucide-react";
import { useGitHubStatus } from "../../hooks/useGitHubStatus";
import type { UseUpdatesResult } from "../../hooks/useUpdates";

/**
 * The foot of the sidebar: onboarding above, the account below.
 *
 * This is where the old activity rail's bottom cluster went when the rail was
 * folded away. Cursor puts the same three things here and stacks them in this
 * order — a getting-started card while there is still something to set up, then
 * a single row carrying who you are signed in as and the way into settings.
 *
 * Note the inversion in the card: it is *darker* than the sidebar it sits in
 * (`surface-sunken` #151515 on the rail's #181818), not lighter. Cursor recesses
 * a card rather than raising it, and gets the separation from the hairline
 * rather than from a tonal step upward. Getting that backwards is the single
 * quickest way to make this footer stop looking like Cursor.
 */

export interface SidebarFooterProps {
  onConnectGitHub: () => void;
  onOpenSettings: () => void;
  /**
   * The shell's one update check. Read rather than started here: two places
   * polling GitHub is two places that can disagree about whether you are
   * behind, and the pill is the one chromatic element in the window — it must
   * never be lit for a reason the rest of the app does not share.
   */
  updates: UseUpdatesResult;
  onOpenUpdate: () => void;
}

export const SidebarFooter: React.FC<SidebarFooterProps> = ({
  onConnectGitHub,
  onOpenSettings,
  updates,
  onOpenUpdate,
}) => {
  const { status: github } = useGitHubStatus();
  const update = updates.status;

  // Lit only when there is genuinely a newer release, and not when the check
  // itself failed — "we could not ask" is a different fact from "up to date",
  // and neither is a reason to colour the one coloured thing in the window.
  const updateAvailable = Boolean(update?.updateAvailable && update.latest && !updates.dismissed);
  const connected = Boolean(github?.connected);
  const name = github?.login ?? "Local Gateway";

  return (
    <div className="flex-shrink-0 pb-2">
      {/* ── Getting started ──────────────────────────────────────────────
          Only while there is a step left to take. A permanent onboarding card
          is just furniture, and it costs the chat list 90px of height. */}
      {!connected && (
        <div className="mx-2 mb-2 rounded-xl bg-surface-sunken border border-edge p-2">
          <div className="flex items-center justify-between px-1 pb-2 pt-0.5">
            <span className="text-sm text-ink-muted">Getting Started</span>
            <span className="text-2xs text-ink-soft">1/2</span>
          </div>
          <button
            type="button"
            onClick={onConnectGitHub}
            className="w-full h-8 rounded-lg bg-surface-raised hover:bg-surface-hover text-sm text-ink-high flex items-center justify-center gap-2 transition-colors duration-ds ease-ds"
          >
            <Github size={14} />
            Connect GitHub
          </button>
        </div>
      )}

      {/* ── Account ──────────────────────────────────────────────────────── */}
      <div className="mx-2 h-9 flex items-center gap-2.5 px-1.5">
        <button
          type="button"
          onClick={onOpenSettings}
          title={connected ? `GitHub · @${name}` : "Local Gateway"}
          className="w-[26px] h-[26px] rounded-full bg-surface-raised hover:bg-surface-hover text-2xs text-ink-muted flex items-center justify-center flex-shrink-0 uppercase transition-colors duration-ds ease-ds"
        >
          {name.slice(0, 1)}
        </button>

        <span className="flex-1 min-w-0 truncate text-sm text-ink-muted">{name}</span>

        {updateAvailable && (
          <button
            type="button"
            onClick={onOpenUpdate}
            title={`${update?.latest?.name ?? "Update"} is available — you are on ${update?.version ?? "an unknown version"}`}
            className="h-5 px-2.5 rounded-full bg-action hover:bg-action-hover text-action-ink text-2xs font-medium flex-shrink-0 transition-colors duration-ds ease-ds"
          >
            Update
          </button>
        )}

        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings (⌘,)"
          aria-label="Settings"
          className="w-6 h-6 flex items-center justify-center rounded-md flex-shrink-0 text-ink-muted hover:text-ink-high hover:bg-surface-hover transition-colors duration-ds ease-ds"
        >
          <Settings size={15} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
};
