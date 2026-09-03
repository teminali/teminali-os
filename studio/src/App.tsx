import React, { useCallback, useEffect, useState } from "react";
import { MacCloseButton } from "./components/ui";
import { StudioTitleBar } from "./components/layout/StudioTitleBar";
import { SidebarDock } from "./components/sidebar/SidebarDock";
import type { SidebarTabId } from "./components/sidebar/ActivityBar";
import { StudioChat } from "./components/chat/StudioChat";
import { WorkspacePanel } from "./components/workspace/WorkspacePanel";
import { CursorSettingsModal } from "./components/modals/CursorSettingsModal";
import { CommandPaletteModal } from "./components/modals/CommandPaletteModal";
import { SkillsModal } from "./components/modals/SkillsModal";
import { DiffInspectorModal } from "./components/diff/DiffInspectorModal";
import { BenchmarkGapAnalyzer } from "./components/benchmark/BenchmarkGapAnalyzer";
import { CopilotLiveEditController } from "./components/editor/CopilotLiveEditController";
import { AssistantBridge } from "./components/assistant/AssistantBridge";
import { AssistantProvider } from "./components/assistant/AssistantContext";
import { useAssistant } from "./hooks/useAssistant";
import { useUpdates } from "./hooks/useUpdates";
import { UpdateModal } from "./components/updates/UpdateModal";
import { GitHubModal } from "./components/github/GitHubModal";
import { useStudioStore } from "./store/studioStore";
import { usePanelStore } from "./store/panelStore";

/**
 * The studio shell.
 *
 * Four regions under one title bar: the activity rail, the sidebar panel it
 * drives, the conversation, and the workspace panel. The shell owns only what
 * spans them — the sidebar geometry, which tab is selected, the global
 * shortcuts, and the modal layer. Everything else is the business of the
 * region that draws it.
 */

const SIDEBAR_WIDTH_KEY = "frontier_sidebar_width";
const SIDEBAR_COLLAPSED_KEY = "frontier_sidebar_collapsed";
const SIDEBAR_TAB_KEY = "frontier_sidebar_tab";
const DEFAULT_SIDEBAR_WIDTH = 260; // measured: 259px of panel + its 1px divider

export default function App() {
  const [activeView, setActiveView] = useState("agent");
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [isGitHubOpen, setGitHubOpen] = useState(false);
  const [isUpdateOpen, setUpdateOpen] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_SIDEBAR_WIDTH;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
  );
  const [sidebarTab, setSidebarTab] = useState<SidebarTabId>(
    () => (localStorage.getItem(SIDEBAR_TAB_KEY) as SidebarTabId | null) ?? "chats",
  );

  const {
    isBenchmarkModalOpen,
    setBenchmarkModalOpen,
    clearEngineSession,
    chatSessions,
    activeSessionId,
  } = useStudioStore();

  const { open: openPanel, focusOrOpen, toggleOpen: togglePanels } = usePanelStore();

  /**
   * The one screen assistant.
   *
   * It lives here rather than in the chat because it has three doors — the
   * global shortcut, the menu bar item, and the microphone in the composer —
   * and only the shell is above all three. The chat lends it the microphone
   * (see `attachVoice` in StudioChat) so those doors share one session rather
   * than opening onto three recorders.
   */
  const assistant = useAssistant();

  /**
   * The one update check.
   *
   * In the shell rather than in the footer that draws the pill, because the
   * modal and the pill must agree about what version is available, and because
   * a check that lived inside a component would restart every time that
   * component remounted.
   */
  const updates = useUpdates();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_TAB_KEY, sidebarTab);
  }, [sidebarTab]);

  /* ── Global shortcuts ──────────────────────────────────────────────────── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      const key = event.key.toLowerCase();

      // Panel shortcuts mirror the add-menu, so the menu doubles as the
      // shortcut reference and the two can never drift apart.
      if (event.shiftKey) {
        if (key === "b") {
          event.preventDefault();
          focusOrOpen({ kind: "browser" });
          return;
        }
        if (key === "a") {
          event.preventDefault();
          focusOrOpen({ kind: "canvas" });
          return;
        }
        if (key === "s") {
          event.preventDefault();
          openPanel({ kind: "side" });
          return;
        }
        if (key === "g") {
          event.preventDefault();
          focusOrOpen({ kind: "guardian" });
          return;
        }
        // The two coding agents. `focusOrOpen` rather than `open`: an agent tab
        // holds a live CLI session, so a second one is a new conversation with
        // an agent that has forgotten everything — rarely what the shortcut
        // means.
        if (key === "c") {
          event.preventDefault();
          focusOrOpen({ kind: "claude" });
          return;
        }
        if (key === "o") {
          event.preventDefault();
          focusOrOpen({ kind: "codex" });
          return;
        }
        if (key === "u") {
          event.preventDefault();
          focusOrOpen({ kind: "usage" });
          return;
        }
        if (key === "n") {
          event.preventDefault();
          focusOrOpen({ kind: "arena" });
          return;
        }
        if (key === "r") {
          event.preventDefault();
          focusOrOpen({ kind: "release" });
          return;
        }
        if (key === "v") {
          event.preventDefault();
          focusOrOpen({ kind: "video" });
          return;
        }
        // Sidebar tabs keep the editor bindings people already have in their
        // fingers, so the rail needs no legend of its own.
        const tabFor: Record<string, SidebarTabId> = { e: "files", f: "search" };
        if (tabFor[key]) {
          event.preventDefault();
          setSidebarTab(tabFor[key]);
          setSidebarCollapsed(false);
          return;
        }
        return;
      }

      switch (key) {
        case "p":
        case "k":
          event.preventDefault();
          setCommandPaletteOpen((previous) => !previous);
          break;
        case "j":
          event.preventDefault();
          openPanel({ kind: "terminal" });
          break;
        case "g":
          event.preventDefault();
          focusOrOpen({ kind: "file" });
          break;
        case "b":
          event.preventDefault();
          setSidebarCollapsed((previous) => !previous);
          break;
        case "l":
          event.preventDefault();
          setActiveView("agent");
          setSidebarTab("chats");
          setSidebarCollapsed(false);
          break;
        case ",":
          event.preventDefault();
          setSettingsOpen((previous) => !previous);
          break;
        case "\\":
          event.preventDefault();
          togglePanels();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPanel, focusOrOpen, togglePanels]);

  /* ── Menu bar ──────────────────────────────────────────────────────────── */

  // "Open Guardian" in the tray only asks; the panel store is here, so the
  // request lands on the same focusOrOpen path the shortcut and menu use.
  useEffect(() => {
    const bridge = window.teminali;
    if (!bridge) return;
    return bridge.menu.on("menu:open-guardian", () => focusOrOpen({ kind: "guardian" }));
  }, [focusOrOpen]);

  /* ── Sidebar geometry ──────────────────────────────────────────────────── */

  const resizeSidebar = useCallback((delta: number) => {
    setSidebarWidth((previous) => {
      const next = previous + delta;
      // Dragging past the floor collapses rather than clamping, which is what
      // makes the handle feel like a real edge.
      if (next < 130) {
        setSidebarCollapsed(true);
        return DEFAULT_SIDEBAR_WIDTH;
      }
      setSidebarCollapsed(false);
      return Math.min(480, Math.max(200, next));
    });
  }, []);

  const title =
    chatSessions.find((session) => session.id === activeSessionId)?.title ?? "";

  return (
    <AssistantProvider assistant={assistant}>
    <div className="h-screen w-screen overflow-hidden flex flex-col font-sans text-ink select-none bg-ground">
      {/* One flat plane. Cursor puts no gradient behind its window — the only
          tonal step in the shell is the sidebar sitting 3 values lighter than
          the canvas, and a vertical wash would blur exactly that edge. */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-frame-mid">
        <CopilotLiveEditController />
        <AssistantBridge assistant={assistant} />

        <StudioTitleBar
          title={title}
          sidebarWidth={sidebarWidth}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((previous) => !previous)}
          onOpenIde={() => focusOrOpen({ kind: "file" })}
          onOpenOverflow={() => setCommandPaletteOpen(true)}
        />

        <div className="flex-1 min-h-0 flex">
          <SidebarDock
            tab={sidebarTab}
            onSelectTab={setSidebarTab}
            width={sidebarWidth}
            collapsed={sidebarCollapsed}
            onSetCollapsed={setSidebarCollapsed}
            onResize={resizeSidebar}
            onResetWidth={() => {
              setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
              setSidebarCollapsed(false);
            }}
            onNewChat={() => {
              clearEngineSession("frontier");
              setActiveView("agent");
              setSidebarTab("chats");
            }}
            onOpenCustomize={() => setSettingsOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onConnectGitHub={() => setGitHubOpen(true)}
            updates={updates}
            onOpenUpdate={() => setUpdateOpen(true)}
            activeView={activeView}
          />

          <StudioChat
            assistant={assistant}
            onConnectGitHub={() => setGitHubOpen(true)}
            onOpenWorkspace={() => setCommandPaletteOpen(true)}
          />

          <WorkspacePanel />
        </div>
      </div>

      {/* ── Modal layer ─────────────────────────────────────────────────── */}

      <CursorSettingsModal isOpen={isSettingsOpen} onClose={() => setSettingsOpen(false)} />
      <CommandPaletteModal
        isOpen={isCommandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <GitHubModal isOpen={isGitHubOpen} onClose={() => setGitHubOpen(false)} />
      <UpdateModal updates={updates} isOpen={isUpdateOpen} onClose={() => setUpdateOpen(false)} />
      <SkillsModal />
      <DiffInspectorModal />

      {isBenchmarkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="relative w-full max-w-4xl max-h-[85vh] bg-surface-sunken border border-edge rounded-xl shadow-modal overflow-y-auto">
            <div className="absolute top-3 right-3 z-10">
              <MacCloseButton onClose={() => setBenchmarkModalOpen(false)} size={14} />
            </div>
            <BenchmarkGapAnalyzer />
          </div>
        </div>
      )}
    </div>
    </AssistantProvider>
  );
}
