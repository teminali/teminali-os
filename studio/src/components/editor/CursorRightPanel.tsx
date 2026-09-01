import React, { useState } from "react";
import {
  Terminal,
  FileText,
  Globe,
  Maximize2,
  Minimize2,
  Plus,
  X,
  Minus,
  MessageSquare,
  Sparkles,
  Columns2,
  Rows2,
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
  initialTab = "terminal",
  width = 600,
  onResizeWidth,
  onResetWidth,
  isMaximized = false,
  onToggleMaximize,
  onMinimizeToRail,
}) => {
  const { tabs, activeTabId, splitTab, setSplitTab } = useStudioStore();
  const activeTab = splitTab || initialTab;
  const setActiveTab = (tab: "terminal" | "editor" | "browser") => setSplitTab(tab);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isInternalSplit, setIsInternalSplit] = useState(false);
  const [internalSplitRatio, setInternalSplitRatio] = useState(50);

  const currentFile = tabs.find((t) => t.id === activeTabId) || null;

  const handleResizeInternal = (delta: number) => {
    setInternalSplitRatio((prev) => Math.min(80, Math.max(20, prev + delta * 0.2)));
  };

  return (
    <div className="relative flex h-full z-20 flex-shrink-0">
      {/* Left resize handle (inverts delta because dragging left increases width) */}
      {!isMaximized && onResizeWidth && (
        <ResizeHandle
          orientation="vertical"
          onResize={(delta) => onResizeWidth(-delta)}
          onDoubleClick={onResetWidth}
        />
      )}

      <div
        style={{ width: isMaximized ? "100%" : `${width}px` }}
        className={`bg-[#121212] border-l border-white/5 flex flex-col h-full font-sans transition-all duration-75 relative select-none ${
          isMaximized ? "fixed inset-0 z-50 bg-[#121212]" : ""
        }`}
      >
        {/* Top Tab Bar */}
        <header className="h-10 px-3 flex items-center justify-between border-b border-white/5 bg-[#141414] select-none flex-shrink-0">
          {/* Left Tabs & Plus Button */}
          <div className="flex items-center gap-1">
            {/* Terminal Tab */}
            <button
              onClick={() => setActiveTab("terminal")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === "terminal"
                  ? "bg-[#222222] text-white"
                  : "text-gray-400 hover:text-white hover:bg-white/5"
              }`}
            >
              <Terminal size={13} className="text-[#38bdf8]" />
              <span>zsh</span>
            </button>

            {/* Editor / File Tab */}
            {currentFile && (
              <button
                onClick={() => setActiveTab("editor")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === "editor"
                    ? "bg-[#222222] text-white"
                    : "text-gray-400 hover:text-white hover:bg-white/5"
                }`}
              >
                <FileText size={13} className="text-[#38bdf8]" />
                <span className="truncate max-w-[120px]">{currentFile.name}</span>
              </button>
            )}

            {/* Browser Preview Tab */}
            <button
              onClick={() => setActiveTab("browser")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === "browser"
                  ? "bg-[#222222] text-white"
                  : "text-gray-400 hover:text-white hover:bg-white/5"
              }`}
            >
              <Globe size={13} className="text-[#10b981]" />
              <span>Browser</span>
            </button>

            {/* Plus Dropdown Menu Button */}
            <div className="relative">
              <button
                onClick={() => setIsMenuOpen((prev) => !prev)}
                className="p-1 text-gray-400 hover:text-white rounded hover:bg-white/5 transition-colors"
                title="Open new tab or view"
              >
                <Plus size={15} />
              </button>

              {/* Dropdown Menu */}
              {isMenuOpen && (
                <div className="absolute top-8 left-0 w-56 bg-[#1f1f1f] border border-white/10 rounded-xl shadow-2xl z-50 p-1.5 text-xs space-y-0.5">
                  <div className="px-2 py-1 text-3xs text-gray-500 font-mono">Open any view...</div>
                  <button
                    onClick={() => {
                      setActiveTab("editor");
                      setIsMenuOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-200 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <FileText size={13} />
                      <span>Editor</span>
                    </div>
                    <span className="text-3xs text-gray-500 font-mono">⌘G</span>
                  </button>

                  <button
                    onClick={() => {
                      setActiveTab("terminal");
                      setIsMenuOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-200 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <Terminal size={13} />
                      <span>Terminal</span>
                    </div>
                    <span className="text-3xs text-gray-500 font-mono">⌘J</span>
                  </button>

                  <button
                    onClick={() => {
                      setActiveTab("browser");
                      setIsMenuOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-200 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <Globe size={13} />
                      <span>Browser</span>
                    </div>
                    <span className="text-3xs text-gray-500 font-mono">⇧⌘B</span>
                  </button>

                  <button
                    onClick={() => {
                      setIsInternalSplit((p) => !p);
                      setIsMenuOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-200 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <Rows2 size={13} />
                      <span>Toggle Editor + Terminal Split</span>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right Layout & Window Controls */}
          <div className="flex items-center gap-1 text-gray-400">
            {/* Split Top/Bottom Toggle */}
            <button
              onClick={() => setIsInternalSplit((p) => !p)}
              className={`p-1 rounded hover:bg-white/5 transition-colors ${
                isInternalSplit ? "text-[#38bdf8] bg-white/5" : "hover:text-white"
              }`}
              title={isInternalSplit ? "Single view" : "Split view (Editor + Terminal)"}
            >
              <Rows2 size={13} />
            </button>

            {/* Snap 50/50 Balance Button */}
            {!isMaximized && onResetWidth && (
              <button
                onClick={onResetWidth}
                className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors"
                title="Balance split (50/50)"
              >
                <Columns2 size={13} />
              </button>
            )}

            {/* Maximize / Restore Toggle */}
            {onToggleMaximize && (
              <button
                onClick={onToggleMaximize}
                className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors"
                title={isMaximized ? "Restore split view" : "Maximize IDE (⌘⇧M)"}
              >
                {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            )}

            {/* Minimize to Rail */}
            {onMinimizeToRail && (
              <button
                onClick={onMinimizeToRail}
                className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors"
                title="Minimize pane"
              >
                <Minus size={13} />
              </button>
            )}

            {/* Close Pane */}
            <button
              onClick={onClose}
              className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors"
              title="Close pane (⌘J)"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        {/* Body Content */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {isInternalSplit ? (
            /* Split Mode: Top Editor/Browser + Bottom Terminal */
            <>
              <div style={{ height: `${internalSplitRatio}%` }} className="w-full overflow-hidden">
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

              <div style={{ height: `${100 - internalSplitRatio}%` }} className="w-full bg-[#0c0d10] p-1 overflow-hidden">
                <TerminalPanel
                  isOpen={true}
                  height={300}
                  onClose={() => setIsInternalSplit(false)}
                  onResizeStart={() => {}}
                />
              </div>
            </>
          ) : (
            /* Single Tab View */
            <>
              {activeTab === "terminal" && (
                <div className="h-full w-full bg-[#0c0d10] p-2">
                  <TerminalPanel
                    isOpen={true}
                    height={500}
                    onClose={onClose}
                    onResizeStart={() => {}}
                  />
                </div>
              )}

              {activeTab === "editor" && (
                <div className="h-full w-full">
                  <EditorPane onPreview={onPreview} />
                </div>
              )}

              {activeTab === "browser" && (
                <div className="h-full w-full">
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
