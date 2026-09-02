import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Download, ExternalLink, Github, Loader2, Lock, RefreshCw, Search, Star,
} from "lucide-react";
import { GitHubService, type GitHubRepo, type GitHubStatus } from "../../services/modelService";
import { useStudioStore } from "../../store/studioStore";
import { refreshGitHubStatus } from "../../hooks/useGitHubStatus";
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
 */

export const GitHubConnect: React.FC<{ compact?: boolean; onCloned?: (path: string) => void }> = ({
  compact = false,
  onCloned,
}) => {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [cloning, setCloning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");

  const setWorkspace = useStudioStore((state) => state.setWorkspace);

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
      onCloned?.(result.path);
      // The clone is now a known project; point the workspace at it.
      setWorkspace("teminali");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setCloning(null);
    }
  };

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center py-10 text-ink-muted">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ── Account ──────────────────────────────────────────────────────── */}
      <div className="lit lit-inner rounded-lg bg-surface px-3 py-2.5 flex items-center gap-3">
        <Github size={16} className="text-ink-prose flex-shrink-0" />
        {status?.connected ? (
          <>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-ink-bright truncate">
                {status.name ? `${status.name} · ` : ""}
                <span className="font-mono text-ink-prose">@{status.login}</span>
              </div>
              <div className="text-3xs text-ink-faint font-mono truncate">
                {status.method === "cli" ? status.cliVersion : "personal access token"}
                {status.scopes?.length ? ` · ${status.scopes.join(", ")}` : ""}
              </div>
            </div>
            <span className="flex items-center gap-1.5 text-2xs text-success flex-shrink-0">
              <StatusDot tone="success" />
              Connected
            </span>
            <IconButton onClick={() => void refresh()} title="Re-check" size={24}>
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            </IconButton>
          </>
        ) : (
          <div className="min-w-0 flex-1 flex flex-col gap-2">
            <p className="text-2xs text-ink-faint leading-relaxed">
              {status?.detail ?? "Not connected."}
            </p>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void connect();
                }}
                placeholder="ghp_… personal access token"
                autoComplete="off"
                spellCheck={false}
                className="lit lit-inner flex-1 min-w-0 h-7 px-2.5 bg-surface-sunken rounded-md font-mono text-2xs text-ink-high placeholder:text-ink-placeholder outline-none"
              />
              <button
                type="button"
                onClick={connect}
                disabled={!token.trim() || loading}
                className="h-7 px-3 rounded-md bg-accent text-frame-top text-2xs font-medium hover:bg-accent-hover disabled:opacity-40 transition-colors duration-ds ease-ds flex-shrink-0"
              >
                Connect
              </button>
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noreferrer"
                title="Create a token"
                className="text-ink-faint hover:text-ink-dim flex-shrink-0"
              >
                <ExternalLink size={12} />
              </a>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-danger/10 border border-danger/25 px-3 py-2 text-2xs text-danger">
          <AlertTriangle size={13} className="flex-shrink-0 mt-px" />
          {error}
        </div>
      )}

      {/* ── Repositories ─────────────────────────────────────────────────── */}
      {status?.connected && (
        <>
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${repos.length} repositories`}
              className="lit lit-inner w-full h-7 pl-7 pr-2 bg-surface rounded-md text-xs text-ink-high placeholder:text-ink-placeholder outline-none"
            />
          </div>

          {loadingRepos ? (
            <div className="flex items-center justify-center py-8 text-ink-muted">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : (
            <div
              className={`rounded-lg border border-edge overflow-y-auto divide-y divide-edge-chrome ${
                compact ? "max-h-64" : "max-h-96"
              }`}
            >
              {visible.map((repo) => (
                <div
                  key={repo.fullName}
                  className="px-3 py-2 flex items-center gap-3 bg-surface hover:bg-surface-hover transition-colors duration-ds ease-ds"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-2xs text-ink-bright truncate">{repo.fullName}</span>
                      {repo.private && <Lock size={9} className="text-ink-disabled flex-shrink-0" />}
                      {repo.stars > 0 && (
                        <span className="flex items-center gap-0.5 text-3xs text-ink-disabled flex-shrink-0">
                          <Star size={9} />
                          {repo.stars}
                        </span>
                      )}
                    </div>
                    {repo.description && (
                      <div className="text-3xs text-ink-faint truncate mt-0.5">{repo.description}</div>
                    )}
                  </div>
                  {repo.language && (
                    <span className="text-3xs text-ink-muted font-mono flex-shrink-0 w-20 text-right truncate">
                      {repo.language}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void clone(repo)}
                    disabled={cloning !== null}
                    className="h-6 px-2 inline-flex items-center gap-1.5 rounded-md bg-surface-chip text-ink-dim text-3xs hover:bg-surface-hover hover:text-ink-high disabled:opacity-40 transition-colors duration-ds ease-ds flex-shrink-0"
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
                <p className="px-3 py-6 text-center text-2xs text-ink-faint">No repository matches that search.</p>
              )}
            </div>
          )}

          <p className="text-3xs text-ink-disabled">
            Clones land beside your current project, shallow by default, and appear in the project switcher.
          </p>
        </>
      )}

      {status?.connected && status.canClone === false && (
        <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/25 px-3 py-2 text-2xs text-warning">
          <AlertTriangle size={13} className="flex-shrink-0 mt-px" />
          This connection has no <span className="font-mono">repo</span> scope, so private repositories cannot be cloned.
        </div>
      )}

    </div>
  );
};
