import React, { useEffect, useState } from "react";
import { FolderOpen, HardDrive, ShieldAlert } from "lucide-react";
import { mediaConsentGate, type PendingConsent } from "../../services/mediaConsent";

/**
 * The media approval prompt.
 *
 * Hosted in `App.tsx`'s modal layer rather than in `VideoPane`, and that is
 * the whole point of it being a modal at all: `WorkspacePanel.tsx` mounts the
 * video panel only when a `video` panel is open, while the tool bridge is
 * registered at module load in `main.tsx` precisely so the tools work either
 * way. A prompt drawn inside the panel would be absent exactly when it is
 * needed most — a call arriving from an agent CLI while the operator is
 * looking at a file.
 *
 * What it says is set by `src/video/P3-import-gate.md` § 7: who asked, the
 * resolved absolute path in full, what the operation costs where that is not
 * obvious, and three answers. There is no "always allow" — no grant survives
 * the session, because there is no UI yet in which to review or revoke one.
 */
export const MediaConsentModal: React.FC = () => {
  const [pending, setPending] = useState<PendingConsent | null>(null);

  useEffect(() => mediaConsentGate().subscribe(setPending), []);

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape denies. Nothing here is bound to Enter: the two allowing
      // answers differ in scope, and a default that grants a folder to a
      // reflex keypress is how consent gets manufactured.
      if (event.key === "Escape") {
        event.preventDefault();
        mediaConsentGate().answer("deny");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending]);

  if (!pending) return null;

  const gate = mediaConsentGate();
  const spawns = pending.capabilities.includes("spawn");
  const folders = pending.folders;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Media access request"
        className="w-full max-w-lg bg-surface-sunken border border-edge rounded-xl shadow-modal overflow-hidden"
      >
        <header className="flex items-start gap-3 px-4 pt-4 pb-3">
          <span className="mt-0.5 flex-shrink-0 text-warning">
            <ShieldAlert size={18} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink-high">
              {spawns ? "Run ffmpeg on a file?" : "Read a file from disk?"}
            </h2>
            {/* Who asked, in the same words `executeTool` was given. A call
                from the sentence the operator just typed is not a call from a
                process running unattended, and they should be able to tell. */}
            <p className="mt-0.5 text-2xs text-ink-muted">
              <span className="text-ink-body">{pending.agentName}</span> called{" "}
              <code className="font-mono text-ink-body">{pending.tool}</code>
            </p>
          </div>
        </header>

        {/* The resolved path, in full and never elided: it is the whole
            question. Symlinks are already followed and `..` collapsed, so this
            string is the one that will actually be opened. */}
        <div className="mx-4 rounded-lg bg-surface-skeleton border border-edge-subtle px-3 py-2 space-y-1">
          {pending.resolved.map((path) => (
            <p key={path} className="font-mono text-2xs text-ink-high break-all leading-relaxed">
              {path}
            </p>
          ))}
        </div>

        {pending.detail && (
          <p className="px-4 pt-2.5 text-2xs text-ink-muted leading-relaxed">{pending.detail}</p>
        )}

        <p className="px-4 pt-2.5 pb-3 text-2xs text-ink-disabled leading-relaxed">
          {spawns
            ? "Allowing this also lets ffmpeg run for the rest of this session. Nothing is written over the original file, and nothing is remembered after you quit."
            : "The grant lasts until you quit Teminali Code. Nothing is written to disk and nothing is remembered."}
        </p>

        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-edge-subtle">
          <button
            type="button"
            onClick={() => gate.answer("deny")}
            className="px-3 h-8 rounded-lg text-2xs font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink-high focus-visible:outline focus-visible:outline-1 focus-visible:outline-edge-popover transition-colors"
          >
            Deny
          </button>

          <button
            type="button"
            onClick={() => gate.answer("file")}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg text-2xs font-semibold text-ink-body bg-surface hover:bg-surface-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-edge-popover transition-colors"
          >
            <HardDrive size={12} className="opacity-70" />
            Allow this file
          </button>

          {/*
            Folder scope is here because the gate has to survive being used.
            A per-file prompt on a forty-clip shoot is forty prompts, and the
            fortieth is answered without being read — which manufactures
            consent and records it as real. One prompt per shoot converges.
          */}
          <button
            type="button"
            onClick={() => gate.answer("folder")}
            title={folders.join("\n")}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg text-2xs font-semibold bg-success/15 text-success hover:bg-success/25 focus-visible:outline focus-visible:outline-1 focus-visible:outline-success transition-colors"
          >
            <FolderOpen size={12} className="opacity-80" />
            Allow this folder
          </button>
        </footer>
      </div>
    </div>
  );
};
