import React, { useState } from "react";
import {
  Search,
  SlidersHorizontal,
  Folder,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  Settings,
  Sparkles,
  ArrowLeft,
  ArrowRight,
  Filter,
  Bot,
  Zap,
  UserPlus,
  Terminal,
  BookOpen,
  Keyboard,
  Sliders,
  LogOut,
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
  width = 256,
  onResizeWidth,
  onResetWidth,
  isCollapsed = false,
  onToggleCollapse,
}) => {
  const {
    setSkillsModalOpen,
    setBenchmarkModalOpen,
    frontierMessages,
    files,
    openFile,
  } = useStudioStore();

  const [isFrontierOpen, setIsFrontierOpen] = useState(true);
  const [isHomeOpen, setIsHomeOpen] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);

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
        language: name.endsWith(".ts") || name.endsWith(".tsx") ? "typescript" : "javascript",
      });
      onOpenFile?.("editor");
    }
  };

  // Render Mini Collapsed Rail (48px)
  if (isCollapsed) {
    return (
      <aside className="w-12 bg-[#141414] border-r border-white/5 flex flex-col justify-between items-center py-2 select-none text-[#9ca3af] h-full flex-shrink-0 z-30 transition-all duration-200">
        <div className="flex flex-col items-center gap-3 w-full">
          {/* macOS dots */}
          <div className="flex flex-col items-center gap-1.5 py-1">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56] inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e] inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f] inline-block" />
          </div>

          <div className="w-6 border-t border-white/5 my-0.5" />

          {/* Expand Sidebar Toggle Button */}
          <button
            onClick={onToggleCollapse}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
            title="Expand Sidebar (⌘B)"
          >
            <PanelLeftOpen size={16} />
          </button>

          {/* Quick Action Icons */}
          <button
            onClick={onNewAgent}
            className={`p-2 rounded-lg transition-colors ${
              activeView === "agent" ? "bg-[#252525] text-[#38bdf8]" : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
            title="New Agent"
          >
            <Bot size={16} />
          </button>

          <button
            onClick={() => setActiveView("search")}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
            title="Search (⌘P)"
          >
            <Search size={15} />
          </button>

          <button
            onClick={() => setSkillsModalOpen(true)}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
            title="Skills & Automations"
          >
            <Zap size={15} className="text-[#eab308]" />
          </button>

          <button
            onClick={() => onOpenFile?.("editor")}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
            title="Open Files"
          >
            <Folder size={15} className="text-[#38bdf8]" />
          </button>
        </div>

        {/* Bottom User & Settings */}
        <div className="flex flex-col items-center gap-2 w-full">
          <button
            onClick={() => setBenchmarkModalOpen(true)}
            className="p-2 text-[#38bdf8] hover:bg-white/5 rounded-lg transition-colors"
            title="Frontier Pro & Benchmarks"
          >
            <Sparkles size={15} />
          </button>

          <button
            onClick={onOpenSettings}
            className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
            title="Settings (⌘,)"
          >
            <Settings size={15} />
          </button>

          <div
            onClick={onOpenSettings}
            className="w-6 h-6 rounded-full bg-gradient-to-br from-[#0284c7] to-[#0369a1] text-white font-bold flex items-center justify-center text-3xs border border-white/10 cursor-pointer hover:opacity-90"
            title="Frontier Developer (Pro)"
          >
            F
          </div>
        </div>
      </aside>
    );
  }

  // Render Full Resizable Sidebar
  return (
    <div className="relative flex h-full z-30 flex-shrink-0">
      <aside
        style={{ width: `${width}px` }}
        className="bg-[#141414] border-r border-white/5 flex flex-col justify-between select-none text-[#9ca3af] font-sans text-xs h-full relative"
      >
        {/* Top Header & Actions */}
        <div className="flex flex-col">
          {/* macOS Traffic Lights + Navigation + Collapse Toggle */}
          <div className="h-10 px-3 flex items-center justify-between border-b border-transparent">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[#ff5f56] inline-block shadow-sm cursor-pointer" />
              <span className="w-3 h-3 rounded-full bg-[#ffbd2e] inline-block shadow-sm cursor-pointer" />
              <span className="w-3 h-3 rounded-full bg-[#27c93f] inline-block shadow-sm cursor-pointer" />
            </div>
            <div className="flex items-center gap-1 text-[#6b7280]">
              <button className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors">
                <ArrowLeft size={14} />
              </button>
              <button className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors">
                <ArrowRight size={14} />
              </button>
              <button
                onClick={onToggleCollapse}
                className="p-1 text-gray-500 hover:text-white rounded hover:bg-white/5 transition-colors ml-1"
                title="Collapse Sidebar (⌘B)"
              >
                <PanelLeftClose size={14} />
              </button>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="px-2 pt-2 pb-3 space-y-1">
            <button
              onClick={onNewAgent}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeView === "agent"
                  ? "bg-[#252525] text-white shadow-sm"
                  : "text-[#d1d5db] hover:bg-white/5 hover:text-white"
              }`}
            >
              <Bot size={16} className="text-[#38bdf8]" />
              <span>New Teminali Agent</span>
            </button>

            <button
              onClick={() => setActiveView("search")}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                activeView === "search"
                  ? "bg-[#252525] text-white"
                  : "text-[#9ca3af] hover:bg-white/5 hover:text-white"
              }`}
            >
              <Search size={15} />
              <span>Search</span>
            </button>

            <button
              onClick={() => setSkillsModalOpen(true)}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                activeView === "automations"
                  ? "bg-[#252525] text-white"
                  : "text-[#9ca3af] hover:bg-white/5 hover:text-white"
              }`}
            >
              <Zap size={15} className="text-[#eab308]" />
              <span>Skills & Automations</span>
            </button>

            <button
              onClick={onOpenSettings}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-[#9ca3af] hover:bg-white/5 hover:text-white transition-colors"
            >
              <SlidersHorizontal size={15} />
              <span>Settings</span>
            </button>
          </div>

          {/* Repositories Section Header */}
          <div className="px-3 pt-2 pb-1 flex items-center justify-between text-2xs font-semibold text-[#6b7280] uppercase tracking-wider">
            <span>Repositories</span>
            <div className="flex items-center gap-1">
              <button className="p-0.5 hover:text-white rounded hover:bg-white/5" title="Filter repos">
                <Filter size={12} />
              </button>
              <button className="p-0.5 hover:text-white rounded hover:bg-white/5" title="New Folder">
                <FolderPlus size={12} />
              </button>
            </div>
          </div>

          {/* Repositories List */}
          <div className="px-2 py-1 space-y-0.5 overflow-y-auto max-h-[calc(100vh-280px)]">
            {/* teminali repo */}
            <div>
              <button
                onClick={() => setIsFrontierOpen((prev) => !prev)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5 text-xs text-[#d1d5db] transition-colors"
              >
                {isFrontierOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Folder size={14} className="text-[#38bdf8]" />
                <span className="font-medium truncate">teminali</span>
              </button>

              {isFrontierOpen && (
                <div className="pl-5 pr-1 py-0.5 space-y-0.5">
                  {/* Active chat session pill */}
                  {frontierMessages && frontierMessages.length > 1 && (
                    <button 
                      onClick={() => setActiveView("agent")}
                      className="w-full flex items-center justify-between px-2 py-1 rounded bg-[#202020] text-white text-xs mb-1"
                    >
                      <span className="truncate">Project analysis</span>
                      <span className="text-3xs text-[#6b7280] font-mono">1m</span>
                    </button>
                  )}

                  {/* Real workspace files */}
                  {(files || []).slice(0, 10).map((file) => (
                    <button
                      key={file.id}
                      onClick={() => void handleOpenFileClick(file.path, file.name)}
                      className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-white/5 text-xs text-gray-300 hover:text-white transition-colors text-left truncate"
                    >
                      <FileIcon name={file.name} isDirectory={file.type === "directory"} />
                      <span className="truncate">{file.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Home repo */}
            <div>
              <button
                onClick={() => setIsHomeOpen((prev) => !prev)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5 text-xs text-[#9ca3af] transition-colors"
              >
                {isHomeOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Folder size={14} className="text-[#9ca3af]" />
                <span className="truncate">Home</span>
              </button>

              {isHomeOpen && (
                <div className="pl-6 pr-1 py-0.5 space-y-0.5">
                  <div className="px-2 py-1 text-2xs text-[#6b7280]">No active sessions</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Profile Menu Popup */}
        {isProfileMenuOpen && (
          <div className="absolute bottom-20 left-3 w-56 bg-[#1c1c1c] border border-white/10 rounded-xl shadow-2xl z-50 p-1.5 text-xs space-y-0.5">
            <button
              onClick={() => {
                onOpenSettings();
                setIsProfileMenuOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 text-left transition-colors"
            >
              <UserPlus size={14} className="text-gray-400" />
              <span>Teminali Profile</span>
            </button>
            <button
              onClick={() => {
                onOpenFile?.("terminal");
                setIsProfileMenuOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 text-left transition-colors"
            >
              <Terminal size={14} className="text-[#38bdf8]" />
              <span>Teminali CLI Terminal</span>
            </button>
            <button
              onClick={() => {
                window.open("https://github.com", "_blank");
                setIsProfileMenuOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 text-left transition-colors"
            >
              <BookOpen size={14} className="text-gray-400" />
              <span>Documentation</span>
            </button>
            <button
              onClick={() => {
                onOpenSettings();
                setIsProfileMenuOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 text-left transition-colors"
            >
              <Keyboard size={14} className="text-gray-400" />
              <span>Keyboard Shortcuts</span>
            </button>
            <button
              onClick={() => {
                setSkillsModalOpen(true);
                setIsProfileMenuOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 text-left transition-colors"
            >
              <Sliders size={14} className="text-gray-400" />
              <span>Skills & Packs</span>
            </button>
            <div className="my-1 border-t border-white/5" />
            <button
              onClick={() => setIsProfileMenuOpen(false)}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 text-left transition-colors"
            >
              <LogOut size={14} className="text-gray-400" />
              <span>Log Out</span>
            </button>
          </div>
        )}

        {/* Bottom User Card / Upgrade Pill */}
        <div className="p-3 border-t border-white/5 space-y-2.5">
          {/* Pro Account Button */}
          <button
            onClick={() => setBenchmarkModalOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-[#1c1c1c] hover:bg-[#252525] border border-white/5 text-xs text-[#d1d5db] font-medium transition-all group"
          >
            <Sparkles size={14} className="text-[#38bdf8] group-hover:rotate-12 transition-transform" />
            <span>Teminali Pro</span>
          </button>

          {/* User Info Bar */}
          <div className="flex items-center justify-between pt-1">
            <div
              onClick={() => setIsProfileMenuOpen((prev) => !prev)}
              className="flex items-center gap-2.5 cursor-pointer hover:opacity-90 transition-opacity"
            >
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#38bdf8] via-[#0284c7] to-[#0369a1] text-white font-extrabold flex items-center justify-center text-[10px] border border-white/20 shadow-md">
                TC
              </div>
              <div className="flex flex-col truncate">
                <span className="text-xs font-semibold text-white leading-tight truncate">Teminali Developer</span>
                <span className="text-3xs text-[#38bdf8]">Local Flagship</span>
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                onClick={() => setBenchmarkModalOpen(true)}
                className="px-2 py-0.5 rounded-full bg-[#38bdf8] hover:bg-[#0284c7] text-black font-semibold text-2xs transition-colors shadow-sm"
              >
                Pro
              </button>
              <button
                onClick={onOpenSettings}
                className="p-1 text-[#6b7280] hover:text-white rounded hover:bg-white/5 transition-colors"
              >
                <Settings size={14} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Resizable drag divider handle */}
      {onResizeWidth && (
        <ResizeHandle
          orientation="vertical"
          onResize={onResizeWidth}
          onDoubleClick={onResetWidth}
        />
      )}
    </div>
  );
};
