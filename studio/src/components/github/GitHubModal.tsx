import React from "react";
import { Github } from "lucide-react";
import { DialogCloseButton } from "../ui";
import { GitHubConnect } from "./GitHubConnect";

/**
 * GitHub in a dialog, for the two places that offer it as a single action —
 * the sidebar's getting-started card and the empty state's call to action.
 * The settings pane embeds `GitHubConnect` directly instead.
 */
export const GitHubModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  React.useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Connect GitHub"
        onClick={(event) => event.stopPropagation()}
        className="lit lit-inner w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl bg-frame-mid shadow-modal overflow-hidden animate-in"
      >
        <div className="h-11 flex-shrink-0 flex items-center gap-2.5 px-4 border-b border-edge-chrome">
          <Github size={15} className="text-ink-prose" />
          <span className="text-sm text-ink-bright">Connect GitHub</span>
          <div className="flex-1" />
          <DialogCloseButton onClose={onClose} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          <GitHubConnect onCloned={onClose} />
        </div>
      </div>
    </div>
  );
};
