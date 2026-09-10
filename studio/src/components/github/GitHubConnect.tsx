import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Download, ExternalLink, Github, Loader2, Lock, RefreshCw, Search, Star,
} from "lucide-react";
import { GitHubService, type GitHubRepo, type GitHubStatus } from "../../services/modelService";
import { useStudioStore } from "../../store/studioStore";
import { WorkspaceService } from "../../services/workspaceService";
import { refreshGitHubStatus } from "../../hooks/useGitHubStatus";
import { SettingGroup, SettingRow } from "../ui/Setting";
import { IconButton, StatusDot } from "../ui";

/**
 * Connecting the studio to GitHub.
 *
 * The `gh` CLI is preferred over asking for a token: on a developer machine it
 * is usually already authenticated, its credential lives in the OS keychain,
 * and the studio then never has to hold one. A personal access token is the
 * fallback for machines without it.
 *
 * Cloning writes beside the current workspace root rather than inside it, so a
 * clone never nests one project within another.
 *
 * **Shape.** The account is a `SettingGroup` of rows, because sign-in state and
 * the token field are settings. The repository list is a second group but not a
 * row family inside it: a catalogue of two hundred repositories is a list, and
 * a list dressed as a set of settings reads as one very long setting. The group
 * gives it the card and the hairlines; the rows inside it are repositories.
 * Before this it was neither — a private stack of `lit` cards that the settings
 * page then wrapped in a card of its own.
 *
 * Two callers, one shape: `GitPane` renders it directly into the settings page,
 * and `GitHubModal` renders it in a dialog for the sidebar and the empty state.
 * The groups are self-contained cards, so they sit correctly in both.
 */

export const GitHubConnect: React.FC<{ onCloned?: (path: string) => void }> = ({ onCloned }) => {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [cloning, setCloning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");

  const setWorkspacePath = useStudioStore((state) => state.setWorkspacePath);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const next = await GitHubService.status(signal);
      setStatus(next);
      // Push the new value to the sidebar and the empty state too.
      void refreshGitHubStatus();
      setError(null);
      if (next.connected) {
        setLoadingRepos(true);
        try {
          setRepos((await GitHubService.repos(signal)).repos);
        } finally {
          if (!signal?.aborted) setLoadingRepos(false);
        }
      }
    } catch (failure) {
      if (!signal?.aborted) setError((failure as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter((repo) => `${repo.fullName} ${repo.description ?? ""} ${repo.language ?? ""}`.toLowerCase().includes(needle));
  }, [repos, query]);

  const connect = async () => {
    if (!token.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await GitHubService.setToken(token.trim()));
      setToken("");
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const clone = async (repo: GitHubRepo) => {
    setCloning(repo.fullName);
    setError(null);
    try {
      const result = await GitHubService.clone(repo.fullName);
      // Open the clone that was just made. This used to call
      // `setWorkspace("teminali")`, which pointed the shell at a path hardcoded
      // in the store rather than at the repository the operator had asked for —
      // so cloning anything moved the workspace somewhere else entirely.
      const opened = await WorkspaceService.openProject(result.path);
      setWorkspacePath(opened.current.path);
      onCloned?.(opened.current.path);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setCloning(null);
    }
  };

  /*
    The waiting state is a row inside the Account card, not a bare spinner on the
    page. GitPane renders this component directly now, so anything returned here
    is the whole screen: an unhoused spinner floats in the middle of empty space
    and then the real card lands somewhere else entirely. A card that keeps its
    place and fills in is the same wait without the jump.
  */
  if (loading && !status) {
    return (
      <div className="space-y-6">
        <SettingGroup label="Account">
          <SettingRow
            label={
              <span className="flex items-center gap-2 text-ink-muted">
                <Loader2 size={14} className="flex-shrink-0 animate-spin" />
                Checking your GitHub CLI sign-in…
              </span>
            }
            description="Asking the GitHub CLI who it is already signed in as. Nothing is sent anywhere."
          />
        </SettingGroup>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Account ──────────────────────────────────────────────────────── */}
      <SettingGroup label="Account">
        {status?.connected ? (
          <SettingRow
            label={
              <span className="flex items-center gap-2">
                <Github size={14} className="flex-shrink-0 text-ink-muted" />
                <span className="truncate">
                  {status.name ? `${status.name} · ` : ""}
                  <span className="font-mono text-ink-prose">@{status.login}</span>
                </span>
              </span>
            }
            description={
              <span className="font-mono">
                {status.method === "cli" ? status.cliVersion : "personal access token"}
                {status.scopes?.length ? ` · ${status.scopes.join(", ")}` : ""}
              </span>
            }
          >
            <span className="flex items-center gap-1.5 text-2xs text-success">
              <StatusDot tone="success" />
              Connected
            </span>
            <IconButton onClick={() => void refresh()} title="Re-check" size={24}>
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            </IconButton>
          </SettingRow>
        ) : (
          <>
            <SettingRow
              label={
                <span className="flex items-center gap-2">
                  <Github size={14} className="flex-shrink-0 text-ink-muted" />
                  GitHub sign-in
                </span>
              }
              description={status?.detail ?? "Not connected."}
            />
            {/* The token field is a full-width cell rather than a control in the
                right-hand column: a password field, a button and a link to
                create the token do not fit beside a label, and truncating the
                field is truncating the only part that matters. */}
            <div className="flex items-center gap-2 px-3.5 py-3">
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void connect();
                }}
                placeholder="ghp_… personal access token"
                aria-label="Personal access token"
                autoComplete="off"
                spellCheck={false}
                className="lit lit-inner h-7 min-w-0 flex-1 rounded-md bg-surface-sunken px-2.5 font-mono text-2xs text-ink-high placeholder:text-ink-placeholder outline-none"
              />
              <button
                type="button"
                onClick={connect}
                disabled={!token.trim() || loading}
                className="h-7 flex-shrink-0 rounded-md bg-accent px-3 text-2xs font-medium text-frame-top transition-colors duration-ds ease-ds hover:bg-accent-hover disabled:opacity-40"
              >
                Connect
              </button>
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noreferrer"
                title="Create a token"
                className="flex-shrink-0 text-ink-faint hover:text-ink-dim"
              >
                <ExternalLink size={12} />
              </a>
            </div>
          </>
        )}

        {status?.connected && status.canClone === false && (
          <div className="flex items-start gap-2 bg-warning/5 px-3.5 py-3 text-2xs text-warning">
            <AlertTriangle size={13} className="mt-px flex-shrink-0" />
            <span>
              This connection has no <span className="font-mono">repo</span> scope, so private repositories cannot be
              cloned.
            </span>
          </div>
        )}
      </SettingGroup>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-2xs text-danger">
          <AlertTriangle size={13} className="mt-px flex-shrink-0" />
          {error}
        </div>
      )}

      {/* ── Repositories ─────────────────────────────────────────────────── */}
      {status?.connected && (
        <SettingGroup
          label="Repositories"
          description="Clones land beside your current project, shallow by default, and appear in the project switcher."
        >
          <div className="relative px-3.5 py-2.5">
            <Search
              size={12}
              className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-ink-faint"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${repos.length} repositories`}
              aria-label="Search repositories"
              className="lit lit-inner h-7 w-full rounded-md bg-surface-sunken pl-7 pr-2 text-xs text-ink-high placeholder:text-ink-placeholder outline-none"
            />
          </div>

          {loadingRepos ? (
            <div className="flex items-center justify-center py-8 text-ink-muted">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : (
            /* The list draws its own hairlines with the same divider the group
               uses, so a hundred repositories are one cell of the card rather
               than a second card inside it.

               It does not scroll on its own. Both callers already own a
               scrollport — the settings page, and the modal's `flex-1 min-h-0
               overflow-y-auto` body — so the `max-h-96` this used to carry put
               383px of window over 2254px of list and trapped the wheel inside
               a card that looked like part of the page. One scrollport per
               screen; the list is long because the account is, and a long list
               on a page that scrolls is not a problem that needs solving twice.
               Sticky search was considered and does not work here: the group's
               card is `overflow-hidden`, which makes it the sticky element's
               scrollport and pins it to nothing. */
            <div className="divide-y divide-edge-chrome">
              {visible.map((repo) => (
                <div
                  key={repo.fullName}
                  className="flex items-center gap-3 px-3.5 py-2 transition-colors duration-ds ease-ds hover:bg-surface-hover"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-2xs text-ink-bright">{repo.fullName}</span>
                      {repo.private && <Lock size={9} className="flex-shrink-0 text-ink-disabled" />}
                      {repo.stars > 0 && (
                        <span className="flex flex-shrink-0 items-center gap-0.5 text-3xs text-ink-disabled">
                          <Star size={9} />
                          {repo.stars}
                        </span>
                      )}
                    </div>
                    {repo.description && (
                      <div className="mt-0.5 truncate text-3xs text-ink-faint">{repo.description}</div>
                    )}
                  </div>
                  {repo.language && (
                    <span className="w-20 flex-shrink-0 truncate text-right font-mono text-3xs text-ink-muted">
                      {repo.language}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void clone(repo)}
                    disabled={cloning !== null}
                    className="inline-flex h-6 flex-shrink-0 items-center gap-1.5 rounded-md bg-surface-chip px-2 text-3xs text-ink-dim transition-colors duration-ds ease-ds hover:bg-surface-hover hover:text-ink-high disabled:opacity-40"
                  >
                    {cloning === repo.fullName ? (
                      <>
                        <Loader2 size={9} className="animate-spin" />
                        Cloning
                      </>
                    ) : (
                      <>
                        <Download size={9} />
                        Clone
                      </>
                    )}
                  </button>
                </div>
              ))}
              {visible.length === 0 && (
                <p className="px-3.5 py-6 text-center text-2xs text-ink-faint">No repository matches that search.</p>
              )}
            </div>
          )}
        </SettingGroup>
      )}
    </div>
  );
};
