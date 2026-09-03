import React from "react";
import { PanelRight } from "lucide-react";
import { usePanelStore, useActivePanel } from "../../store/panelStore";
import { EmptyState } from "../ui";
import { ResizeHandle } from "../layout/ResizeHandle";
import { TerminalPane } from "./panels/TerminalPane";
import { BrowserPane } from "./panels/BrowserPane";
import { FilePane } from "./panels/FilePane";
import { CanvasPane } from "./panels/CanvasPane";
import { SideChatPane } from "./panels/SideChatPane";
import { AgentPane } from "./panels/AgentPane";
import { UsagePane } from "./panels/UsagePane";
import { ReleasePane } from "./panels/ReleasePane";
import { ArenaPane } from "./panels/ArenaPane";
import { VideoPane } from "./panels/VideoPane";
import { GuardianPanel } from "../guardian/GuardianPanel";

/**
 * The right-hand workspace region.
 *
 * It owns no chrome of its own — the tab strip lives in the title bar so the
 * panel and the header stay visually continuous — and does nothing but resolve
 * the active tab to its pane. Each pane is mounted per panel id so switching
 * tabs preserves scroll position, terminal history and unsaved edits.
 */

export const WorkspacePanel: React.FC = () => {
  const { panels, isOpen, isExpanded, width, setWidth, setAddMenuOpen } = usePanelStore();
  const active = useActivePanel();

  if (!isOpen) return null;

  return (
    <>
      <ResizeHandle
        onResize={(delta) => setWidth(width - delta)}
        onDoubleClick={() => setWidth(452)}
        orientation="vertical"
      />
      {/* Cursor's right panel is not a distinct plane — it is the canvas with
          content in it, separated by one hairline and nothing else. Painting it
          a step darker or lighter is what made this read as a third region
          rather than as part of the conversation's surface. */}
      <aside
        className="flex-shrink-0 flex flex-col min-h-0 border-l border-edge-chrome bg-panelbg-mid"
        style={{ width: isExpanded ? "var(--panel-w-expanded)" : width }}
      >
        {panels.length === 0 ? (
          <EmptyState
            icon={<PanelRight size={30} strokeWidth={1.6} />}
            title="No panels open"
            action={{ label: "Open a panel", onClick: () => setAddMenuOpen(true) }}
          />
        ) : active ? (
          <PaneFor key={active.id} />
        ) : null}
      </aside>
    </>
  );
};

/** Resolve the active panel to its pane. Split out so the key remount is clean. */
const PaneFor: React.FC = () => {
  const panel = useActivePanel();
  if (!panel) return null;
  switch (panel.kind) {
    case "terminal":
      return <TerminalPane panel={panel} />;
    case "browser":
      return <BrowserPane panel={panel} />;
    case "file":
      return <FilePane panel={panel} />;
    case "canvas":
      return <CanvasPane />;
    case "side":
      return <SideChatPane panel={panel} />;
    case "guardian":
      return <GuardianPanel />;
    case "usage":
      return <UsagePane />;
    case "release":
      return <ReleasePane />;
    case "arena":
      return <ArenaPane />;
    case "video":
      return <VideoPane />;
    case "claude":
    case "codex":
      return <AgentPane panel={panel as typeof panel & { kind: "claude" | "codex" }} />;
    default:
      return null;
  }
};
