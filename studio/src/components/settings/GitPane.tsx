import React from "react";
import { GitBranch } from "lucide-react";
import { SettingGroup, SettingRow, SettingSelect } from "../ui/Setting";
import { GitHubConnect } from "../github/GitHubConnect";
import { useStudioStore } from "../../store/studioStore";
import type { LinkDestination } from "../../services/preferences";

/**
 * Git & PRs.
 *
 * The plan adopted five of Cursor's rows here. Four of them are absent, and
 * the reason is the same for all four: **the app does not make commits or pull
 * requests.** There is no `git commit`, no `gh pr create` and no review flow
 * anywhere in `src/` or `server/` — GitHub integration is sign-in, repository
 * listing and clone. So Review Provider, Commit Attribution, PR Attribution
 * and Branch Prefix would each be a control over something that never happens,
 * which is the exact failure this whole settings lane exists to undo. They
 * arrive with the capability, not before it.
 *
 * The fifth row survives, and grew. Cursor's "PR Link Destination" chooses
 * where a PR link opens; we have no PR links, but we do have an in-app browser
 * and a chat full of links, so ours governs every link in the app. That is a
 * bigger row than Cursor's, not a smaller one — see
 * `docs/SETTINGS_AND_CHROME_PLAN.md` §3.
 */
export const GitPane: React.FC = () => {
  const preferences = useStudioStore((state) => state.preferences);
  const setPreferences = useStudioStore((state) => state.setPreferences);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink-bright">
          <GitBranch size={16} className="text-accent" />
          Git &amp; PRs
        </h1>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-ink-muted">
          The studio uses your existing GitHub CLI sign-in where it can, so it never has to hold a
          credential of its own.
        </p>
      </div>

      <SettingGroup label="Links">
        <SettingRow
          label="Open Links In"
          description="Where a link in a chat answer opens. The in-app browser puts the page in a panel beside the conversation that produced it; the system browser hands it to your default browser. Hold ⌘ to override either way."
        >
          <SettingSelect
            value={preferences.linkDestination}
            onChange={(event) =>
              setPreferences({ linkDestination: event.target.value as LinkDestination })
            }
            aria-label="Open links in"
          >
            <option value="in-app">In-app browser</option>
            <option value="system">System browser</option>
          </SettingSelect>
        </SettingRow>
      </SettingGroup>

      {/* GitHubConnect draws its own Account and Repositories groups now, so it
          no longer needs a card wrapped around it here. It used to be a private
          stack of cards inside one — a card in a card in a page. */}
      <GitHubConnect />
    </div>
  );
};

/** The row labels this pane carries, for the settings rail's search. */
export const GIT_ROWS = ["Open Links In", "GitHub sign-in"];
