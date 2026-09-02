import React from "react";
import { Activity, ChartColumn, FileText, MessageSquare, PenLine, Rocket, Scale, SquareTerminal, Globe } from "lucide-react";
import { BrandGlyph } from "../ui";
import type { PanelKind } from "../../store/panelStore";

/**
 * One glyph per panel kind, so a tab, a menu row and an empty state never
 * disagree about what a terminal or a canvas looks like.
 */
export const PanelGlyph: React.FC<{ kind: PanelKind; size?: number; className?: string }> = ({
  kind,
  size = 14,
  className = "",
}) => {
  const props = { size, className, strokeWidth: 2 } as const;
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
    case "file":
    default:
      return <FileText {...props} />;
  }
};
