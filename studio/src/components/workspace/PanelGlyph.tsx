import React from "react";
import { Activity, ChartColumn, Clapperboard, EyeOff, FileText, LayoutGrid, MessageSquare, PenLine, Rocket, Scale, SquareTerminal, Globe } from "lucide-react";
import { BrandGlyph } from "../ui";
import type { PanelKind } from "../../store/panelStore";

/**
 * One glyph per panel kind, so a tab, a menu row and an empty state never
 * disagree about what a terminal or a canvas looks like.
 *
 * `private` is the one exception to one-glyph-per-kind, and it earns it: on a
 * strip where the inactive tabs are icons with no label, a private browser tab
 * that drew the same globe as every other would be indistinguishable from the
 * one place a page must not be opened by accident.
 */
export const PanelGlyph: React.FC<{
  kind: PanelKind;
  size?: number;
  className?: string;
  private?: boolean;
}> = ({ kind, size = 14, className = "", private: isPrivate = false }) => {
  const props = { size, className, strokeWidth: 2 } as const;
  if (isPrivate && kind === "browser") return <EyeOff {...props} />;
  switch (kind) {
    case "terminal":
      return <SquareTerminal {...props} />;
    case "browser":
      return <Globe {...props} />;
    case "canvas":
      return <PenLine {...props} />;
    case "side":
      return <MessageSquare {...props} />;
    case "guardian":
      return <Activity {...props} />;
    // The real marks: on a strip where several agents can be open at once,
    // their own logos are what makes a tab identifiable at a glance.
    case "claude":
      return <BrandGlyph brand="claude" size={size} className={className} />;
    case "codex":
      return <BrandGlyph brand="codex" size={size} className={className} />;
    case "usage":
      return <ChartColumn {...props} />;
    case "release":
      return <Rocket {...props} />;
    case "arena":
      return <Scale {...props} />;
    case "video":
      return <Clapperboard {...props} />;
    // A grid, because that is what the panel is: the contents of one folder.
    // The clapperboard belongs to the editor, and a tab strip where the two
    // wore the same mark would not say which one holds a timeline.
    case "gallery":
      return <LayoutGrid {...props} />;
    case "file":
    default:
      return <FileText {...props} />;
  }
};
