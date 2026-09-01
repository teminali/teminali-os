import React, { useState } from "react";
import {
  Search,
  Folder,
  FolderPlus,
  FilePlus,
  ChevronRight,
  ChevronDown,
  Settings,
  Sparkles,
  Zap,
  Terminal,
  Layers,
  Globe,
  GitBranch,
  Bot,
  MessageSquare,
  Blocks,
  RefreshCw,
  X,
  FileCode,
  Check,
  Laptop,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";
import { FileIcon } from "./FileTree";
import { WorkspaceService } from "../../services/workspaceService";
import { ResizeHandle } from "../layout/ResizeHandle";

export const CursorSidebar: React.FC<{
  activeView: string;
  setActiveView: (view: string) => void;
  onNewAgent: () => void;
  onOpenSettings: () => void;
  onOpenFile?: (tab: "editor" | "terminal" | "browser") => void;
  width?: number;
  onResizeWidth?: (delta: number) => void;
  onResetWidth?: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}> = ({
  activeView,
  setActiveView,
  onNewAgent,
  onOpenSettings,
  onOpenFile,
  width = 260,
  onResizeWidth,
  onResetWidth,
  isCollapsed = false,
  onToggleCollapse,
}) => {
  const {
    setSkillsModalOpen,
    setBenchmarkModalOpen,
    files,
    openFile,
    tabs,
    activeTabId,
    setActiveTab,
    closeTab,
    addUntitledTab,
  } = useStudioStore();

  const [activeRailTab, setActiveRailTab] = useState<"chat" | "explorer" | "search" | "git" | "skills">("chat");
  const [searchQuery, setSearchQuery] = useState("");
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(true);
  const [isOpenEditorsOpen, setIsOpenEditorsOpen] = useState(true);

  const handleOpenFileClick = async (path: string, name: string) => {
    try {
      const file = await WorkspaceService.readFile(path);
      openFile(file);
      onOpenFile?.("editor");
    } catch {
      openFile({
        name,
        path,
        content: `// Workspace file: ${name}\n`,
        language: name.endsWith(".ts") || name.endsWith(".tsx") ? "typescript" : name.endsWith(".html") ? "html" : "javascript",
      });
      onOpenFile?.("editor");
    }
  };

  // Filtered files for search
  const filteredFiles = files.filter((f) =>
    f.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    f.path.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="relative flex h-full z-30 flex-shrink-0 select-none font-sans">
      {/* ── Left Slim Activity Rail (48px) ─────────────────────────────── */}
      <nav className="w-12 bg-[#090b10] border-r border-white/5 flex flex-col justify-between items-center py-2 flex-shrink-0 z-40">
        {/* Top: App Traffic Dots + View Switchers */}
        <div className="flex flex-col items-center gap-1 w-full">
          {/* macOS Traffic Light Dots */}
          <div className="flex items-center gap-1.5 py-1.5 mb-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56] inline-block shadow-sm" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e] inline-block shadow-sm" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f] inline-block shadow-sm" />
          </div>

          <div className="w-6 border-t border-white/5 mb-1" />

          {/* Chat / Composer Tab */}
          <button
            onClick={() => {
              setActiveRailTab("chat");
              setActiveView("agent");
              if (isCollapsed && onToggleCollapse) onToggleCollapse();
            }}
            className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
              activeRailTab === "chat"
                ? "bg-[#141724] text-[#FF6C37] shadow-sm"
                : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
            title="Chat & Composer (⌘L)"
          >
            {activeRailTab === "chat" && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-[#FF6C37] rounded-r" />
            )}
            <MessageSquare size={16} />
          </button>

          {/* Explorer / Files Tab */}
          <button
            onClick={() => {
              setActiveRailTab("explorer");
              if (isCollapsed && onToggleCollapse) onToggleCollapse();
            }}
            className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
              activeRailTab === "explorer"
                ? "bg-[#141724] text-[#FF6C37] shadow-sm"
                : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
            title="Explorer / Files (⌘E)"
          >
            {activeRailTab === "explorer" && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-[#FF6C37] rounded-r" />
            )}
            <Folder size={16} />
          </button>

          {/* Search Tab */}
          <button
            onClick={() => {
              setActiveRailTab("search");
              if (isCollapsed && onToggleCollapse) onToggleCollapse();
            }}
            className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
              activeRailTab === "search"
                ? "bg-[#141724] text-[#FF6C37] shadow-sm"
                : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
            title="Search Workspace (⌘P / ⌘F)"
          >
            {activeRailTab === "search" && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-[#FF6C37] rounded-r" />
            )}
            <Search size={16} />
          </button>

          {/* Skills & Automations Tab */}
          <button
            onClick={() => setSkillsModalOpen(true)}
            className="relative w-9 h-9 rounded-lg flex items-center justify-center text-gray-400 hover:text-amber-300 hover:bg-white/5 transition-all"
            title="Specialist Skills & Automations"
          >
            <Zap size={16} className="text-amber-400/90" />
          </button>
        </div>

        {/* Bottom: Pro Benchmarks + Settings + Profile */}
        <div className="flex flex-col items-center gap-1.5 w-full">
          <button
            onClick={() => setBenchmarkModalOpen(true)}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[#FF6C37] hover:bg-white/5 transition-colors"
            title="Teminali Intelligence & Benchmarks"
          >
            <Sparkles size={16} />
          </button>

          <button
            onClick={onOpenSettings}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
            title="Settings (⌘,)"
          >
            <Settings size={16} />
          </button>

          <div
            onClick={onOpenSettings}
            className="w-7 h-7 rounded-full bg-gradient-to-tr from-[#0284c7] to-[#FF6C37] text-white font-bold flex items-center justify-center text-3xs border border-white/10 cursor-pointer shadow-md hover:scale-105 transition-transform"
            title="Teminali Developer (Active Pro)"
          >
            T
          </div>
        </div>
      </nav>

      {/* ── Collapsible Primary Sidebar (Tree & Details) ───────────────── */}
      {!isCollapsed && (
        <aside
          style={{ width: `${width}px` }}
          className="bg-[#0e1017] border-r border-white/5 flex flex-col justify-between text-gray-300 text-xs h-full relative"
        >
          {/* Header Bar */}
          <header className="h-10 px-3 flex items-center justify-between border-b border-white/5 bg-[#0e1017] flex-shrink-0">
            <span className="font-semibold text-xs text-gray-200 tracking-tight uppercase text-3xs text-gray-400">
              {activeRailTab === "chat" && "Teminali Code"}
              {activeRailTab === "explorer" && "Explorer"}
              {activeRailTab === "search" && "Search Files"}
            </span>

            <div className="flex items-center gap-1">
              {activeRailTab === "explorer" && (
                <>
                  <button
                    onClick={addUntitledTab}
                    className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/5"
                    title="New File"
                  >
                    <FilePlus size={13} />
                  </button>
                  <button
                    onClick={() => {}}
                    className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/5"
                    title="Refresh Explorer"
                  >
                    <RefreshCw size={13} />
                  </button>
                </>
              )}

              {onToggleCollapse && (
                <button
                  onClick={onToggleCollapse}
                  className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/5"
                  title="Collapse Sidebar (⌘B)"
                >
                  <PanelLeftClose size={14} />
                </button>
              )}
            </div>
          </header>

          {/* View Contents */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-2 space-y-4 text-xs font-sans">
            {/* 1. Chat Tab Content */}
            {activeRailTab === "chat" && (
              <div className="space-y-3">
                <button
                  onClick={onNewAgent}
                  className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-[#FF6C37] text-black font-semibold text-xs hover:bg-[#ff7d4d] transition-colors shadow-sm"
                >
                  <Bot size={14} />
                  <span>New Teminali Code Chat</span>
                </button>

                <div className="pt-2">
                  <div className="px-2 py-1 text-3xs font-semibold text-gray-500 uppercase tracking-wider">
                    Recent Sessions
                  </div>
                  <div className="space-y-0.5 mt-1">
                    <button className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/5 text-white font-medium text-left">
                      <MessageSquare size={13} className="text-[#FF6C37]" />
                      <span className="truncate">Active Workspace Chat</span>
                    </button>
                  </div>
                </div>

                <div className="pt-2 border-t border-white/5">
                  <div className="px-2 py-1 text-3xs font-semibold text-gray-500 uppercase tracking-wider">
                    Quick Workspaces
                  </div>
                  <div className="space-y-0.5 mt-1">
                    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 cursor-pointer">
                      <Folder size={13} className="text-[#FF6C37]" />
                      <span className="truncate">~/Documents/my_projects/teminali</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 2. Explorer Tab Content */}
            {activeRailTab === "explorer" && (
              <div className="space-y-3">
                {/* Open Editors Section */}
                <div>
                  <button
                    onClick={() => setIsOpenEditorsOpen(!isOpenEditorsOpen)}
                    className="w-full flex items-center gap-1.5 px-1 py-1 text-3xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-200"
                  >
                    {isOpenEditorsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span>Open Editors ({tabs.length})</span>
                  </button>

                  {isOpenEditorsOpen && (
                    <div className="mt-1 space-y-0.5 pl-2">
                      {tabs.map((tab) => (
                        <div
                          key={tab.id}
                          onClick={() => {
                            setActiveTab(tab.id);
                            onOpenFile?.("editor");
                          }}
                          className={`group flex items-center justify-between px-2 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                            tab.id === activeTabId
                              ? "bg-[#1f2438] text-white font-medium shadow-sm"
                              : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                          }`}
                        >
                          <div className="flex items-center gap-1.5 truncate">
                            <FileIcon name={tab.name} />
                            <span className="truncate">{tab.name}</span>
                            {tab.isDirty && <span className="w-1.5 h-1.5 rounded-full bg-[#FF6C37]" />}
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              closeTab(tab.id);
                            }}
                            className="p-0.5 rounded text-gray-500 hover:text-white opacity-0 group-hover:opacity-100"
                          >
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Workspace Files Tree */}
                <div>
                  <button
                    onClick={() => setIsWorkspaceOpen(!isWorkspaceOpen)}
                    className="w-full flex items-center gap-1.5 px-1 py-1 text-3xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-200"
                  >
                    {isWorkspaceOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span>Teminali Workspace</span>
                  </button>

                  {isWorkspaceOpen && (
                    <div className="mt-1 space-y-0.5 pl-2">
                      {files.map((file) => (
                        <div
                          key={file.id || file.path}
                          onClick={() => handleOpenFileClick(file.path, file.name)}
                          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-gray-400 hover:text-white hover:bg-white/5 cursor-pointer transition-colors"
                        >
                          <FileIcon name={file.name} />
                          <span className="truncate">{file.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 3. Search Tab Content */}
            {activeRailTab === "search" && (
              <div className="space-y-3">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-2.5 text-gray-500" />
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search files by name..."
                    className="w-full h-8 pl-8 pr-2 bg-[#141724] border border-white/10 rounded-lg text-xs text-white focus:outline-none focus:border-[#FF6C37]/40"
                    autoFocus
                  />
                </div>

                <div className="space-y-1">
                  <span className="text-3xs font-semibold text-gray-500 uppercase tracking-wider px-1">
                    {filteredFiles.length} files found
                  </span>
                  {filteredFiles.map((file) => (
                    <div
                      key={file.id || file.path}
                      onClick={() => handleOpenFileClick(file.path, file.name)}
                      className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-white/5 cursor-pointer transition-colors"
                    >
                      <FileIcon name={file.name} />
                      <div className="flex flex-col truncate">
                        <span className="text-gray-200 font-medium truncate">{file.name}</span>
                        <span className="text-3xs text-gray-500 truncate">{file.path}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Sidebar Footer */}
          <footer className="p-2 border-t border-white/5 bg-[#0b0d13] flex items-center justify-between text-3xs text-gray-500 font-mono">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span>Local Gateway 4310</span>
            </span>
            <span>v1.0.0</span>
          </footer>
        </aside>
      )}

      {/* Sidebar Resize Handle */}
      {!isCollapsed && onResizeWidth && (
        <ResizeHandle
          orientation="vertical"
          onResize={onResizeWidth}
          onDoubleClick={onResetWidth}
        />
      )}
    </div>
  );
};
