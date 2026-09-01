import React, { useState, useEffect, useRef } from "react";
import { CursorSidebar } from "./components/sidebar/CursorSidebar";
import { CursorChatCanvas } from "./components/chat/CursorChatCanvas";
import { CursorRightPanel } from "./components/editor/CursorRightPanel";
import { CursorSettingsModal } from "./components/modals/CursorSettingsModal";
import { SkillsModal } from "./components/modals/SkillsModal";
import { BenchmarkGapAnalyzer } from "./components/benchmark/BenchmarkGapAnalyzer";
import { DiffInspectorModal } from "./components/diff/DiffInspectorModal";
import { NearbyMeshModal } from "./components/mesh/NearbyMeshModal";
import { CommandPaletteModal } from "./components/modals/CommandPaletteModal";
import { useStudioStore } from "./store/studioStore";
import { X } from "lucide-react";
import { CopilotLiveEditController } from "./components/editor/CopilotLiveEditController";

export default function App() {
  const stageRef = useRef<HTMLElement>(null);
  const [activeView, setActiveView] = useState("agent");
  const { isSplitOpen, setSplitOpen, splitTab, setSplitTab } = useStudioStore();
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Resizing and Minimizing State
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem("frontier_sidebar_width");
    return saved ? parseInt(saved, 10) || 256 : 256;
  });
  const [isSidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    return localStorage.getItem("frontier_sidebar_collapsed") === "true";
  });
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    const saved = localStorage.getItem("frontier_right_panel_width");
    return saved ? parseInt(saved, 10) || 620 : 620;
  });
  const [isRightPanelMaximized, setRightPanelMaximized] = useState<boolean>(false);

  const {
    isNearbyMeshOpen,
    setNearbyMeshOpen,
    isBenchmarkModalOpen,
    setBenchmarkModalOpen,
    clearEngineSession,
  } = useStudioStore();

  useEffect(() => {
    localStorage.setItem("frontier_sidebar_width", sidebarWidth.toString());
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem("frontier_sidebar_collapsed", isSidebarCollapsed.toString());
  }, [isSidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem("frontier_right_panel_width", rightPanelWidth.toString());
  }, [rightPanelWidth]);

  useEffect(() => {
    const handleGlobalKeys = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "k")) {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setActiveView("agent");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setSplitTab("terminal");
        setSplitOpen(!isSplitOpen);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setRightPanelMaximized((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleGlobalKeys);
    return () => window.removeEventListener("keydown", handleGlobalKeys);
  }, []);

  const handleNewAgent = () => {
    clearEngineSession("frontier");
    setActiveView("agent");
  };

  const handleOpenSplit = (tab?: "terminal" | "editor" | "browser") => {
    if (tab) {
      setSplitTab(tab);
      setSplitOpen(true);
    } else {
      setSplitOpen(!isSplitOpen);
    }
  };

  // Sidebar resize handlers
  const handleResizeSidebar = (delta: number) => {
    setSidebarWidth((prev) => {
      const next = prev + delta;
      if (next < 130) {
        setSidebarCollapsed(true);
        return 256;
      }
      if (isSidebarCollapsed) setSidebarCollapsed(false);
      return Math.min(480, Math.max(180, next));
    });
  };

  const handleResetSidebar = () => {
    setSidebarWidth(256);
    setSidebarCollapsed(false);
  };

  // Right Panel resize handlers
  const handleResizeRightPanel = (delta: number) => {
    setRightPanelWidth((prev) => {
      const maxAllowed = window.innerWidth - (isSidebarCollapsed ? 48 : sidebarWidth) - 300;
      return Math.min(maxAllowed, Math.max(320, prev + delta));
    });
  };

  const handleResetRightPanel = () => {
    const available = window.innerWidth - (isSidebarCollapsed ? 48 : sidebarWidth);
    setRightPanelWidth(Math.floor(available / 2));
    setRightPanelMaximized(false);
  };

  return (
    <main ref={stageRef} className="h-screen w-screen bg-[#090b10] overflow-hidden flex flex-col font-sans select-none text-gray-200">
      <CopilotLiveEditController />

      {/* Main Workspace Container */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Cursor Left Sidebar */}
        <CursorSidebar
          activeView={activeView}
          setActiveView={setActiveView}
          onNewAgent={handleNewAgent}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenFile={(tab) => handleOpenSplit(tab)}
          width={sidebarWidth}
          onResizeWidth={handleResizeSidebar}
          onResetWidth={handleResetSidebar}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((p) => !p)}
        />

        {/* Cursor Center Chat Canvas */}
        <CursorChatCanvas
          isSplitOpen={isSplitOpen}
          onOpenSplit={handleOpenSplit}
        />

        {/* Cursor Right Split Panel (When IDE Split toggled) */}
        {isSplitOpen && (
          <CursorRightPanel
            initialTab={splitTab}
            onClose={() => setSplitOpen(false)}
            onPreview={() => {}}
            width={rightPanelWidth}
            onResizeWidth={handleResizeRightPanel}
            onResetWidth={handleResetRightPanel}
            isMaximized={isRightPanelMaximized}
            onToggleMaximize={() => setRightPanelMaximized((p) => !p)}
            onMinimizeToRail={() => setSplitOpen(false)}
          />
        )}
      </div>

      {/* Modals & Dialogs */}
      <CursorSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      {isBenchmarkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="relative w-full max-w-4xl max-h-[85vh] bg-[#0e1117] border border-white/10 shadow-2xl rounded-2xl overflow-y-auto">
            <button
              onClick={() => setBenchmarkModalOpen(false)}
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-white bg-black/40 hover:bg-black/80 rounded-full transition-all z-10"
            >
              <X className="w-5 h-5" />
            </button>
            <BenchmarkGapAnalyzer />
          </div>
        </div>
      )}

      <SkillsModal />
      <DiffInspectorModal />
      <NearbyMeshModal isOpen={isNearbyMeshOpen} onClose={() => setNearbyMeshOpen(false)} />
      <CommandPaletteModal isOpen={isCommandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
    </main>
  );
}
