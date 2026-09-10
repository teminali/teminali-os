import React, { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { SettingGroup, SettingRow } from "../ui/Setting";
import { PlatformService, type Identity } from "../../services/platformService";
import { useStudioStore } from "../../store/studioStore";
import { preferredName } from "../../services/preferences";

/**
 * Profile.
 *
 * Cursor's profile screen is an account page: handle, public profile, links to
 * a hosted identity. We have none of that and are not building it to fill a
 * screen, so what is left is the honest half — who this machine thinks you
 * are, and what you would like to be called.
 *
 * The identity is read, never edited: it is a GitHub account, and an app that
 * offered to change your name on it would be lying about what the field does.
 * The display name is the one editable thing here, and it is ours — a local
 * preference for how the app addresses you, which is why it can be blank and
 * fall back to the GitHub name rather than being seeded with it.
 */
export const ProfilePane: React.FC = () => {
  const preferences = useStudioStore((state) => state.preferences);
  const setPreferences = useStudioStore((state) => state.setPreferences);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void PlatformService.me(controller.signal).then((next) => {
      setIdentity(next);
      setLoading(false);
    });
    return () => controller.abort();
  }, []);

  const connected = Boolean(identity?.connected);
  const shown = preferredName(identity);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-bright">Profile</h1>
        <p className="mt-1 text-xs text-ink-muted">Who this machine thinks you are.</p>
      </div>

      <SettingGroup label="Identity">
        <SettingRow
          label="GitHub account"
          description={
            loading
              ? "Reading…"
              : connected
                ? `Signed in as ${identity?.login}. Read from your existing GitHub CLI sign-in — the studio never holds a credential of its own.`
                : "Not signed in. Connect from Git & PRs; nothing here needs it, but cloning a repository does."
          }
        >
          {identity?.avatarUrl ? (
            <img
              src={identity.avatarUrl}
              alt=""
              className="h-8 w-8 rounded-full border border-edge object-cover"
            />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-edge bg-surface-chip text-ink-muted">
              <UserRound size={14} />
            </span>
          )}
        </SettingRow>

        {identity?.isAdmin && (
          <SettingRow
            label="Administrator"
            description="This account administers the studio. Administrators are set once and listed in the gateway, not here."
          >
            <span className="rounded-md border border-accent/25 bg-accent/10 px-2 py-1 text-2xs font-medium text-accent">
              Admin
            </span>
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup
        label="Display name"
        description="What the app calls you — in greetings and anywhere it addresses you directly. It does not reach GitHub, and nothing outside this machine ever sees it."
      >
        <SettingRow
          label="Name"
          description={
            preferences.displayName.trim()
              ? `The app will call you ${preferences.displayName.trim()}.`
              : shown
                ? `Empty, so the app uses your GitHub name: ${shown}.`
                : "Empty, and there is no GitHub identity to fall back to, so the app will address you without a name."
          }
        >
          <input
            type="text"
            value={preferences.displayName}
            onChange={(event) => setPreferences({ displayName: event.target.value })}
            placeholder={shown ?? "Your name"}
            maxLength={64}
            aria-label="Display name"
            className="lit lit-inner h-7 w-[190px] rounded-md bg-surface-raised px-2 text-xs text-ink-body outline-none placeholder:text-ink-placeholder"
          />
        </SettingRow>
      </SettingGroup>
    </div>
  );
};

/** The row labels this pane carries, for the settings rail's search. */
export const PROFILE_ROWS = ["GitHub account", "Administrator", "Name", "Display name"];
