import React from "react";
import { AlertTriangle, ArrowDownToLine, Check, Download, Loader2, RotateCw } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { CursorMarkdownRenderer } from "../chat/CursorMarkdownRenderer";
import type { UseUpdatesResult } from "../../hooks/useUpdates";

/**
 * Getting a new version onto the machine.
 *
 * Four steps, each visible: download, open, replace, restart. It is more
 * ceremony than an auto-updater and it is what this application can honestly
 * offer — the build is ad-hoc signed, and macOS refuses to apply an in-place
 * update to a binary whose signature it cannot verify. A one-click "Update"
 * button here would be a control that does nothing, which DESIGN.md forbids for
 * exactly this reason.
 *
 * The permission warning is the part not to trim. Every build carries a
 * different ad-hoc signature, macOS keys screen and microphone access to the
 * signature, and so an update silently revokes them. Someone who was not told
 * that would reasonably conclude the assistant broke.
 */

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export interface UpdateModalProps {
  updates: UseUpdatesResult;
  isOpen: boolean;
  onClose: () => void;
}

export const UpdateModal: React.FC<UpdateModalProps> = ({ updates, isOpen, onClose }) => {
  const { status, phase, progress, receivedBytes, error, awaitingRestart } = updates;
  // macOS replaces the bundle in place rather than handing a .dmg to the
  // Finder, so it never asks anyone to drag anything anywhere.
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
  const latest = status?.latest;
  const asset = status?.asset;
  const desktop = Boolean(window.teminali?.updates);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      title={latest ? `${latest.name} is available` : "Updates"}
      subtitle={status?.version ? `You are running ${status.version}` : undefined}
    >
      <div className="space-y-4">
        {/* What changed. */}
        {latest?.notes ? (
          <div className="max-h-56 overflow-y-auto rounded-xl border border-edge bg-surface-sunken px-3.5 py-3">
            <CursorMarkdownRenderer content={latest.notes} />
          </div>
        ) : (
          <p className="text-sm text-ink-faint">This release came with no notes.</p>
        )}

        {/* Nothing to install on this platform is a real state and is named. */}
        {!asset && status?.updateAvailable && (
          <p className="flex items-start gap-2 text-sm text-warning">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" strokeWidth={1.8} />
            <span className="text-ink-muted">
              {status.error ?? "This release has no build for your platform."}
              {latest?.url && (
                <>
                  {" "}
                  <a href={latest.url} target="_blank" rel="noreferrer" className="text-action hover:underline">
                    Open the release page
                  </a>
                </>
              )}
            </span>
          </p>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        {/* Progress. A hundred-and-thirty-megabyte download needs a number. */}
        {phase === "downloading" && (
          <div className="space-y-1.5">
            <div className="h-1 rounded-full bg-chart-track overflow-hidden">
              <div
                className="h-full rounded-full bg-chart transition-[width] duration-ds ease-ds"
                style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
              />
            </div>
            <p className="text-2xs text-ink-faint tabular-nums">
              {megabytes(receivedBytes)}
              {asset?.size ? ` of ${megabytes(asset.size)}` : ""} downloaded
            </p>
          </div>
        )}

        {/* What is left to do, which is a whole step less on macOS. */}
        {(phase === "installed" || awaitingRestart) && (
          <div className="rounded-xl border border-edge bg-surface-sunken px-3.5 py-3 space-y-2">
            <p className="text-sm text-ink-prose">
              {isMac
                ? "The new version is in place. Reopen the app below to start running it."
                : "The installer is open. Follow it through, then reopen the app below."}
            </p>
            <p className="text-2xs text-ink-faint leading-relaxed">
              This app is not signed with an Apple Developer certificate, so macOS treats each new build as a different
              application and clears its Screen Recording, Accessibility and Microphone access. You will be asked to
              grant them once more — the assistant's settings panel says which are missing.
            </p>
          </div>
        )}

        {!desktop && (
          <p className="text-2xs text-ink-faint">
            Updates install from the desktop app. In a browser, download the release from GitHub instead.
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-4">
        <Button variant="ghost" size="sm" onClick={updates.dismiss}>
          Skip this version
        </Button>

        {phase === "downloading" ? (
          <Button variant="secondary" size="sm" onClick={updates.cancel} icon={<Loader2 size={13} className="animate-spin" />}>
            Cancel
          </Button>
        ) : phase === "ready" ? (
          <Button variant="primary" size="sm" onClick={() => void updates.install()} icon={<ArrowDownToLine size={13} />}>
            {isMac ? "Install the update" : "Open the installer"}
          </Button>
        ) : awaitingRestart ? (
          /* The label promises both, and both are attempted: the relaunch is
             queued and then the app quits. If macOS declines to relaunch a
             bundle that was replaced a moment ago, the app has still closed —
             the half the operator was told to expect, and one they can finish
             themselves. It never leaves anyone waiting for a window that is not
             coming. */
          <Button variant="primary" size="sm" onClick={() => void updates.restart()} icon={<RotateCw size={13} />}>
            Close and Reopen
          </Button>
        ) : phase === "installed" ? (
          <Button variant="primary" size="sm" onClick={() => void updates.restart()} icon={<RotateCw size={13} />}>
            Close and Reopen
          </Button>
        ) : asset && desktop ? (
          <Button variant="primary" size="sm" onClick={() => void updates.download()} icon={<Download size={13} />}>
            Download {asset.size ? megabytes(asset.size) : ""}
          </Button>
        ) : latest?.url ? (
          <Button variant="secondary" size="sm" onClick={() => window.open(latest.url ?? "", "_blank", "noopener,noreferrer")}>
            Open on GitHub
          </Button>
        ) : null}
      </div>

      {phase === "ready" && (
        <p className="flex items-center gap-1.5 text-2xs text-success pt-2 justify-end">
          <Check size={11} /> Downloaded
        </p>
      )}
    </Modal>
  );
};
