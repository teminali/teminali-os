import React, { useState } from "react";
import {
  Terminal,
  FileText,
  Globe,
  Maximize2,
  Minimize2,
  Plus,
  X,
  Columns2,
  Rows2,
  ChevronDown,
  Layers,
  FileCode,
} from "lucide-react";
import { EditorPane } from "./EditorPane";
import { TerminalPanel } from "./TerminalPanel";
import { WebsitePreviewPane } from "../preview/WebsitePreviewPane";
import { useStudioStore } from "../../store/studioStore";
import { ResizeHandle } from "../layout/ResizeHandle";

export const CursorRightPanel: React.FC<{
  onClose: () => void;
  onPreview: () => void;
  initialTab?: "terminal" | "editor" | "browser";
  width?: number;
  onResizeWidth?: (delta: number) => void;
  onResetWidth?: () => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  onMinimizeToRail?: () => void;
}> = ({
  onClose,
  onPreview,
  initialTab = "browser",
  width = 620,
  onResizeWidth,
  onResetWidth,
  isMaximized = false,
  onToggleMaximize,
  onMinimizeToRail,
}) => {
  const { tabs, activeTabId, splitTab, setSplitTab, addUntitledTab } = useStudioStore();
  const activeTab = splitTab || initialTab;
  const setActiveTab = (tab: "terminal" | "editor" | "browser") => setSplitTab(tab);

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isInternalSplit, setIsInternalSplit] = useState(false);
  const [internalSplitRatio, setInternalSplitRatio] = useState(55);

  const currentFile = tabs.find((t) => t.id === activeTabId) || null;

  const handleResizeInternal = (delta: number) => {
    setInternalSplitRatio((prev) => Math.min(80, Math.max(20, prev + delta * 0.2)));
  };

  return (
    <div className="relative flex h-full z-20 flex-shrink-0">
      {/* Left resize handle */}
      {!isMaximized && onResizeWidth && (
        <ResizeHandle
          orientation="vertical"
          onResize={(delta) => onResizeWidth(-delta)}
          onDoubleClick={onResetWidth}
        />
      )}

      <div
        style={{ width: isMaximized ? "100%" : `${width}px` }}
        className={`bg-[#0c0e14] border-l border-white/5 flex flex-col h-full font-sans transition-all duration-75 relative select-none ${
          isMaximized ? "fixed inset-0 z-50 bg-[#0c0e14]" : ""
        }`}
      >
        {/* ── Top Tab Bar ─────────────────────────────────────────────── */}
        <header className="h-10 px-3 flex items-center justify-between border-b border-white/5 bg-[#090b10] select-none flex-shrink-0 gap-2">
          {/* Left Tabs */}
          <div className="flex items-center gap-1">
            {/* Live Browser Tab */}
            <button
              onClick={() => setActiveTab("browser")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === "browser"
                  ? "bg-[#1f2438] text-[#38bdf8] border border-[#38bdf8]/30 shadow-sm"
                  : "text-gray-400 hover:text-white hover:bg-white/5 border border-transparent"
              }`}
            >
              <Globe size={13} className="text-[#38bdf8]" />
              <span>Live Browser</span>
            </button>

            {/* Editor Tab */}
            <button
              onClick={() => setActiveTab("editor")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === "editor"
                  ? "bg-[#1f2438] text-white border border-white/10 shadow-sm"
                  : "text-gray-400 hover:text-white hover:bg-white/5 border border-transparent"
              }`}
            >
              <FileCode size={13} className="text-emerald-400" />
              <span className="truncate max-w-[120px]">{currentFile ? currentFile.name : "Editor"}</span>
            </button>

            {/* Terminal Tab */}
            <button
              onClick={() => setActiveTab("terminal")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === "terminal"
                  ? "bg-[#1f2438] text-white border border-white/10 shadow-sm"
                  : "text-gray-400 hover:text-white hover:bg-white/5 border border-transparent"
              }`}
            >
              <Terminal size={13} className="text-amber-400" />
              <span>Terminal (zsh)</span>
            </button>

            {/* Plus New Tab Menu */}
            <div className="relative">
              <button
                onClick={() => setIsMenuOpen((p) => !p)}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
                title="Add panel or split"
              >
                <Plus size={13} />
              </button>

              {isMenuOpen && (
                <div className="absolute top-8 left-0 w-48 bg-[#181b26] border border-white/10 rounded-xl shadow-2xl z-50 p-1 text-xs space-y-0.5">
                  <button
                    onClick={() => {
                      addUntitledTab();
                      setActiveTab("editor");
                      setIsMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 hover:text-white text-left"
                  >
                    <FileText size={13} className="text-emerald-400" />
                    <span>New File</span>
                  </button>

                  <button
                    onClick={() => {
                      setActiveTab("terminal");
                      setIsMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 hover:text-white text-left"
                  >
                    <Terminal size={13} className="text-amber-400" />
                    <span>New Terminal</span>
                  </button>

                  <div className="border-t border-white/5 my-1" />

                  <button
                    onClick={() => {
                      setIsInternalSplit((p) => !p);
                      setIsMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 hover:text-white text-left"
                  >
                    <Rows2 size={13} className="text-[#38bdf8]" />
                    <span>{isInternalSplit ? "Single Pane" : "Split Top / Bottom"}</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right Control Actions */}
          <div className="flex items-center gap-1 text-gray-400">
            {/* Split Top/Bottom Toggle Button */}
            <button
              onClick={() => setIsInternalSplit((p) => !p)}
              className={`p-1.5 rounded hover:bg-white/5 transition-colors ${
                isInternalSplit ? "text-[#38bdf8] bg-white/5" : "hover:text-white"
              }`}
              title={isInternalSplit ? "Close Bottom Split" : "Split Editor & Terminal (Top/Bottom)"}
            >
              <Rows2 size={14} />
            </button>

            {/* Maximize Toggle */}
            {onToggleMaximize && (
              <button
                onClick={onToggleMaximize}
                className="p-1.5 hover:text-white rounded hover:bg-white/5 transition-colors"
                title={isMaximized ? "Restore view" : "Maximize view"}
              >
                {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            )}

            {/* Close Right Panel */}
            <button
              onClick={onClose}
              className="p-1.5 hover:text-white rounded hover:bg-white/5 transition-colors"
              title="Close panel (⌘J)"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        {/* ── Panel Body Content ──────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden relative bg-[#0c0e14]">
          {isInternalSplit ? (
            /* Split Mode: Top Editor/Browser + Bottom Terminal */
            <>
              <div style={{ height: `${internalSplitRatio}%` }} className="w-full overflow-hidden bg-[#0c0e14]">
                {activeTab === "browser" ? (
                  <WebsitePreviewPane activeTab={currentFile} />
                ) : (
                  <EditorPane onPreview={onPreview} />
                )}
              </div>

              {/* Horizontal resize handle */}
              <ResizeHandle
                orientation="horizontal"
                onResize={handleResizeInternal}
                onDoubleClick={() => setInternalSplitRatio(50)}
              />

              <div style={{ height: `${100 - internalSplitRatio}%` }} className="w-full bg-[#08090E] p-1 overflow-hidden">
                <TerminalPanel
                  isOpen={true}
                  height={500}
                  onClose={() => setIsInternalSplit(false)}
                  onResizeStart={() => {}}
                />
              </div>
            </>
          ) : (
            /* Single Pane Mode */
            <>
              {activeTab === "terminal" && (
                <div className="h-full w-full bg-[#08090E]">
                  <TerminalPanel
                    isOpen={true}
                    height={500}
                    onClose={onClose}
                    onResizeStart={() => {}}
                  />
                </div>
              )}

              {activeTab === "editor" && (
                <div className="h-full w-full bg-[#0c0e14]">
                  <EditorPane onPreview={onPreview} />
                </div>
              )}

              {activeTab === "browser" && (
                <div className="h-full w-full bg-[#08090E]">
                  <WebsitePreviewPane activeTab={currentFile} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
