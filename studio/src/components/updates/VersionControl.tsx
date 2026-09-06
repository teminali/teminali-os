import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronUp, Download, Loader2, RefreshCw, RotateCcw, RotateCw } from "lucide-react";
import type { UseUpdatesResult } from "../../hooks/useUpdates";
import type { ReleaseOption } from "../../services/platformService";

/**
 * Which build this is, and the two things you can do about it.
 *
 * ── Why the version is the control ──────────────────────────────────────────
 *
 * The updater already worked; it was simply invisible unless a release happened
 * to be newer than yours, and then it spoke through a pill in the sidebar foot.
 * "Which version am I running" matters more here than in most applications,
 * because this build is ad-hoc signed: every update invalidates the Screen
 * Recording, Accessibility and Microphone grants, so the version is the first
 * thing worth knowing when the assistant starts behaving oddly. Making the
 * version itself the control puts checking, updating and rolling back behind
 * the one label somebody is already looking at when they have that question.
 *
 * ── One version back, not a catalogue ───────────────────────────────────────
 *
 * An update that turns out to be broken is only recoverable in place if the app
 * can install an older build over itself, and this one can: the installer takes
 * whatever zip it downloaded, and `/api/updates/releases` can name an older
 * release's asset as easily as the newest one.
 *
 * Exactly one previous release is offered. The regression a rollback is for
 * arrived in the update that was just installed, so the build before it is the
 * one that answers; a longer list is an invitation to land somewhere nobody is
 * testing, on a version whose saved state the current one may not read.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 *
 * It does not announce anything. There is no banner: an update is a dot on this
 * control and a pill in the sidebar foot, and the release notes still open in
 * `UpdateModal`, which is where reading before committing belongs. This route
 * is the deliberate one, and it is quiet.
 */

/** How long "Up to date" stays up before the row reads normally again. */
const CONFIRMATION_MS = 4000;

/** Previous releases offered. See the header — this is deliberately one. */
const ROLLBACK_CHOICES = 1;

export interface VersionControlProps {
  updates: UseUpdatesResult;
  /** Opens the update modal, which is where release notes are read. */
  onOpenUpdate: () => void;
}

export const VersionControl: React.FC<VersionControlProps> = ({ updates, onOpenUpdate }) => {
  const { status, phase, progress, target, checking, awaitingRestart, error } = updates;

  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [options, setOptions] = useState<ReleaseOption[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const version = status?.version ?? null;
  // Rolling back replaces the running bundle, which only the desktop shell can
  // do. In a browser this is a label and nothing more, and says so by offering
  // nothing it cannot carry out.
  const desktop = Boolean(window.teminali?.updates);
  const updateAvailable = Boolean(status?.updateAvailable && status.latest);
  const newer = updateAvailable ? status?.latest?.tag.replace(/^v/, "") ?? null : null;
  const busy = phase === "downloading" || phase === "opening";

  /* A check that answers with silence is indistinguishable from one that did
     not run, so the up-to-date result is shown — and then expires, because a
     permanent "Up to date" is a claim about now, made then. */
  useEffect(() => {
    if (checking || !status || status.updateAvailable || status.error) return undefined;
    setConfirmed(true);
    const timer = window.setTimeout(() => setConfirmed(false), CONFIRMATION_MS);
    return () => window.clearTimeout(timer);
  }, [checking, status]);

  /* Fetched when the menu opens rather than on mount: it is a round trip to
     GitHub for something most sessions never look at. */
  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    void updates.releases().then((list) => {
      if (cancelled) return;
      setOptions(list?.releases ?? []);
      setListError(list?.error ?? (list ? null : "The release list could not be read."));
    });
    return () => {
      cancelled = true;
    };
  }, [open, options, updates]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = () => {
      setOpen(false);
      setConfirming(null);
    };
    // Pointerdown over the whole control, trigger included, so clicking the
    // version while the menu is open closes it instead of closing and
    // immediately reopening on the click that follows.
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const rollBack = useCallback(
    async (release: ReleaseOption) => {
      if (!release.asset) return;
      setConfirming(null);
      await updates.apply({ url: release.asset.url, name: release.asset.name }, release.version);
    },
    [updates],
  );

  /* The running build is excluded, and so is anything newer than it: going
     forward is an update and has its own row. A release that shipped nothing
     this machine can install is not a place it can go. */
  const older = (options ?? []).filter((release) => release.older && release.asset).slice(0, ROLLBACK_CHOICES);

  /* Floating chrome, so it is over whatever pane owns the window's bottom-right
     corner. The one pane that draws content that far down is the video editor's
     timeline, and it reserves this 30px strip (Timeline.tsx) — move this offset
     and that reservation moves too. */
  return (
    <div ref={root} className="fixed bottom-2 right-3 z-40">
      {open && (
        <div
          role="menu"
          className="lit lit-strong absolute bottom-full right-0 mb-2 w-[268px] rounded-xl bg-surface-popover shadow-popover p-1 animate-in"
        >
          <Group>Version</Group>

          {awaitingRestart || phase === "installed" ? (
            <>
              <p className="px-2.5 pb-1.5 text-2xs text-ink-soft leading-relaxed">
                {target ? `Version ${target} is in place.` : "The new version is in place."} macOS treats each build as a
                different application, so Screen Recording, Accessibility and Microphone have to be granted once more.
              </p>
              <Row icon={<RotateCw size={12} />} label="Close and Reopen" tone="action" onClick={() => void updates.restart()} />
            </>
          ) : (
            <>
              {newer && (
                <Row
                  icon={<Download size={12} />}
                  label={`Update to ${newer}`}
                  tone="action"
                  disabled={busy}
                  onClick={() => {
                    setOpen(false);
                    onOpenUpdate();
                  }}
                />
              )}

              <Row
                icon={<RefreshCw size={12} className={checking ? "animate-spin" : ""} />}
                label={checking ? "Checking…" : "Check for updates"}
                disabled={checking || busy}
                onClick={() => void updates.check()}
              />

              {confirmed && !newer && (
                <p className="flex items-center gap-1.5 px-2.5 py-1 text-2xs text-ink-soft">
                  <Check size={11} className="text-success flex-shrink-0" /> Up to date
                </p>
              )}
              {status?.error && !checking && (
                <p className="px-2.5 py-1 text-2xs text-ink-soft leading-snug">{status.error}</p>
              )}

              <div className="h-px bg-edge my-1" />
              <Group>Roll back</Group>

              {!desktop && (
                <p className="px-2.5 py-1 text-2xs text-ink-soft leading-snug">
                  Versions are switched from the desktop app.
                </p>
              )}

              {desktop && options === null && (
                <p className="flex items-center gap-1.5 px-2.5 py-1 text-2xs text-ink-soft">
                  <Loader2 size={11} className="animate-spin flex-shrink-0" /> Looking…
                </p>
              )}

              {desktop && options !== null && older.length === 0 && (
                <p className="px-2.5 py-1 text-2xs text-ink-soft leading-snug">
                  {listError ?? "No earlier release to go back to."}
                </p>
              )}

              {desktop &&
                older.map((release) => (
                  <div key={release.tag}>
                    <Row
                      icon={<RotateCcw size={12} />}
                      label={busy && target === release.version ? `Installing ${release.version}…` : release.version}
                      meta={release.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : undefined}
                      disabled={busy}
                      onClick={() => setConfirming(confirming === release.version ? null : release.version)}
                    />
                    {/* Confirmed in place rather than done on the first click.
                        This replaces the running application with an older one
                        and costs its permission grants — not something to do
                        because a menu was misread. */}
                    {confirming === release.version && (
                      <div className="px-2.5 pb-2 pt-1">
                        <p className="text-2xs text-ink-soft leading-relaxed mb-2">
                          Replaces {version ?? "this build"} with {release.version} and asks for Screen Recording,
                          Accessibility and Microphone again. Work saved by a newer build may not open.
                        </p>
                        <button
                          type="button"
                          onClick={() => void rollBack(release)}
                          disabled={busy}
                          className="w-full h-7 rounded-md bg-action text-action-ink text-2xs font-medium
                                     hover:bg-action-hover transition-colors duration-ds ease-ds disabled:opacity-60"
                        >
                          Install {release.version}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
            </>
          )}

          {/* Progress bar for download */}
          {phase === "downloading" && (
            <div className="px-2.5 pt-1.5 pb-1 space-y-1.5">
              <div className="h-1 rounded-full bg-chart-track overflow-hidden">
                <div
                  className="h-full rounded-full bg-chart transition-[width] duration-ds ease-ds"
                  style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-2xs text-ink-soft tabular-nums">
                <span className="truncate">{target ? `Downloading ${target}` : "Downloading"}</span>
                <button type="button" onClick={updates.cancel} className="text-ink-faint hover:text-ink-body">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Progress bar for installation */}
          {phase === "opening" && (
            <div className="px-2.5 pt-1.5 pb-1 space-y-1.5">
              <div className="h-1 rounded-full bg-chart-track overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-300 ease-out"
                  style={{ width: `${Math.max(6, Math.min(100, Math.round(updates.installProgress?.percent ?? 45)))}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-2xs text-ink-soft tabular-nums">
                <span className="truncate flex items-center gap-1.5">
                  <Loader2 size={10} className="animate-spin text-emerald-400" />
                  {updates.installProgress?.statusText || "Installing…"}
                </span>
                <span className="font-mono text-emerald-400">
                  {Math.round(updates.installProgress?.percent ?? 45)}%
                </span>
              </div>
            </div>
          )}

          {phase === "failed" && error && (
            <p className="flex items-start gap-1.5 px-2.5 py-1 text-2xs text-danger leading-snug">
              <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Teminali OS ${version ?? ""} — version, updates and rollback`}
        className={`h-[22px] pl-2 pr-1.5 rounded-full flex items-center gap-1 font-mono text-2xs tabular-nums
                    border border-edge bg-surface/80 backdrop-blur-sm transition-colors duration-ds ease-ds
                    ${open ? "text-ink-body" : "text-ink-faint hover:text-ink-muted"}`}
      >
        {busy ? <Loader2 size={10} className="animate-spin flex-shrink-0" /> : null}
        <span>{version ?? "…"}</span>
        {/* Lit for a real newer release, or for one that is installed and
            waiting on a restart. Never for a check that could not run. */}
        {(newer || awaitingRestart) && (
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${awaitingRestart ? "bg-success" : "bg-action"}`} />
        )}
        <ChevronUp size={11} className={`transition-transform duration-ds ease-ds ${open ? "rotate-180" : ""}`} />
      </button>
    </div>
  );
};

/* ── Pieces ───────────────────────────────────────────────────────────────── */

const Group: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center h-6 px-2.5 mt-1 first:mt-0">
    <span className="text-2xs text-ink-faint">{children}</span>
  </div>
);

const Row: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  meta?: string;
  disabled?: boolean;
  tone?: "action";
}> = ({ icon, label, onClick, meta, disabled, tone }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    className={`w-full h-7 px-2.5 rounded-md flex items-center gap-2 text-sm text-left
                transition-colors duration-ds ease-ds disabled:opacity-40 hover:bg-surface-hover
                ${tone === "action" ? "text-action" : "text-ink-body"}`}
  >
    <span className="flex-shrink-0 flex items-center">{icon}</span>
    <span className="truncate">{label}</span>
    <span className="flex-1" />
    {meta && <span className="text-2xs text-ink-soft flex-shrink-0">{meta}</span>}
  </button>
);
