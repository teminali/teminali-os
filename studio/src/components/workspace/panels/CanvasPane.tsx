import React from "react";
import { PenLine } from "lucide-react";
import { useStudioStore } from "../../../store/studioStore";
import { EmptyState } from "../../ui";

/**
 * Canvas — a component preview surface on a dotted ground.
 *
 * It renders the most recent artifact the engine produced. When there is none
 * it says so rather than showing a decorative placeholder that implies output
 * exists.
 */
export const CanvasPane: React.FC = () => {
  const previewUrl = useStudioStore((state) => state.browserPreviewUrl);

  return (
    <div
      className="flex-1 min-h-0 flex items-center justify-center p-6"
      style={{
        backgroundImage: "radial-gradient(var(--surface-hover) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
    >
      {previewUrl ? (
        <div className="lit lit-inner w-full h-full rounded-xl bg-surface overflow-hidden shadow-popover">
          <iframe
            src={previewUrl}
            title="Canvas preview"
            sandbox="allow-scripts allow-same-origin allow-forms"
            className="w-full h-full border-0 bg-white"
          />
        </div>
      ) : (
        <EmptyState
          icon={<PenLine size={28} strokeWidth={1.6} />}
          title="Nothing on the canvas"
          detail="Ask the assistant to build a component or a page and it will render here."
        />
      )}
    </div>
  );
};
