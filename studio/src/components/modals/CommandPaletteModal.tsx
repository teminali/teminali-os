import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Search,
  Bot,
  FileCode,
  ArrowLeft,
  ArrowRight,
  Mic,
  Pin,
  Globe,
  Terminal,
  Settings,
  Zap,
  Sparkles,
  Layers,
  FileText,
  CornerDownLeft,
  X,
  Check,
  RotateCcw,
  Sliders,
  Compass,
} from "lucide-react";
import { useStudioStore, ChatSession } from "../../store/studioStore";
import { WorkspaceService } from "../../services/workspaceService";
import { FileIcon } from "../sidebar/FileTree";
import { SegmentedTabs, Badge } from "../ui";
import type { FileItem } from "../../types";

type FilterTab = "all" | "agents" | "files" | "actions" | "settings";

interface SearchItem {
  id: string;
  category: "Recent Agents" | "Agent" | "Mode" | "Files" | "Settings";
  type: FilterTab;
  title: string;
  subtitle?: string;
  badge?: string;
  shortcut?: string;
  icon: React.ReactNode;
  action: () => void | Promise<void>;
}

function flattenFiles(items: FileItem[]): FileItem[] {
  return items.flatMap((item) =>
    item.type === "file" ? [item] : flattenFiles(item.children || [])
  );
}

export const CommandPaletteModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
}> = ({ isOpen, onClose, onOpenSettings }) => {
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const {
    tabs,
    setActiveTab,
    openFile,
    setBenchmarkModalOpen,
    setSkillsModalOpen,
    purgeVRAM,
    files,
    setSplitOpen,
    setSplitTab,
    openBrowserPreview,
    clearEngineSession,
    currentProfile,
    setProfile,
    chatSessions,
    switchSession,
  } = useStudioStore();

  const filterTabs: Array<{ id: FilterTab; label: string }> = [
    { id: "all", label: "All" },
    { id: "agents", label: "Agents" },
    { id: "files", label: "Files" },
    { id: "actions", label: "Actions" },
    { id: "settings", label: "Settings" },
  ];

  // Build all search items
  const allItems = useMemo<SearchItem[]>(() => {
    const items: SearchItem[] = [];

    // 1. Recent Agents & Chat History
    chatSessions.forEach((session) => {
      items.push({
        id: `agent-session-${session.id}`,
        category: "Recent Agents",
        type: "agents",
        title: session.title,
        subtitle: session.workspace,
        badge: `${session.workspace} · ${session.timestamp}`,
        icon: <Bot className="w-4 h-4 text-[#FF6C37]" />,
        action: () => {
          switchSession(session.id);
          onClose();
        },
      });
    });

    // 2. Agent Core Actions
    items.push(
      {
        id: "action-go-back",
        category: "Agent",
        type: "actions",
        title: "Go Back",
        shortcut: "⌘ [",
        icon: <ArrowLeft className="w-4 h-4 text-gray-400" />,
        action: () => {
          window.history.back();
          onClose();
        },
      },
      {
        id: "action-go-forward",
        category: "Agent",
        type: "actions",
        title: "Go Forward",
        shortcut: "⌘ ]",
        icon: <ArrowRight className="w-4 h-4 text-gray-400" />,
        action: () => {
          window.history.forward();
          onClose();
        },
      },
      {
        id: "action-new-agent",
        category: "Agent",
        type: "actions",
        title: "New Agent",
        shortcut: "⌘ L",
        icon: <Bot className="w-4 h-4 text-[#FF6C37]" />,
        action: () => {
          clearEngineSession("frontier");
          onClose();
        },
      },
      {
        id: "action-dictate",
        category: "Agent",
        type: "actions",
        title: "Dictate / Voice Input",
        shortcut: "⇧ ⌘ _",
        icon: <Mic className="w-4 h-4 text-amber-400" />,
        action: () => {
          onClose();
        },
      },
      {
        id: "action-pin-agent",
        category: "Agent",
        type: "actions",
        title: "Pin / Unpin Agent",
        icon: <Pin className="w-4 h-4 text-gray-400" />,
        action: () => {
          onClose();
        },
      },
      {
        id: "action-open-browser",
        category: "Agent",
        type: "actions",
        title: "Open Live Browser Preview",
        shortcut: "⌘ J",
        icon: <Globe className="w-4 h-4 text-[#FF6C37]" />,
        action: () => {
          openBrowserPreview();
          onClose();
        },
      },
      {
        id: "action-open-terminal",
        category: "Agent",
        type: "actions",
        title: "Open Terminal Panel",
        shortcut: "⌘ J",
        icon: <Terminal className="w-4 h-4 text-emerald-400" />,
        action: () => {
          setSplitTab("terminal");
          setSplitOpen(true);
          onClose();
        },
      }
    );

    // 3. Modes
    items.push(
      {
        id: "mode-plan",
        category: "Mode",
        type: "actions",
        title: "Plan Mode",
        subtitle: "Strategic architecture & design plans without modifying code",
        icon: <Sliders className="w-4 h-4 text-purple-400" />,
        action: () => {
          onClose();
        },
      },
      {
        id: "mode-agent",
        category: "Mode",
        type: "actions",
        title: "Agent Mode (Teminali Auto)",
        subtitle: "Autonomous local multi-file coding and tool execution",
        badge: currentProfile === "auto" ? "Active" : undefined,
        icon: <Zap className="w-4 h-4 text-[#FF6C37]" />,
        action: () => {
          setProfile("auto");
          onClose();
        },
      },
      {
        id: "mode-flash",
        category: "Mode",
        type: "actions",
        title: "Flash Mode (Teminali Flash)",
        subtitle: "Ultra-fast local generation with low memory footprint",
        badge: currentProfile === "flash" ? "Active" : undefined,
        icon: <Sparkles className="w-4 h-4 text-emerald-400" />,
        action: () => {
          setProfile("flash");
          onClose();
        },
      }
    );

    // 4. Workspace Files
    flattenFiles(files).forEach((file) => {
      const filePath = file.path;
      const fileName = filePath.split("/").pop() || filePath;
      items.push({
        id: `file-${filePath}`,
        category: "Files",
        type: "files",
        title: fileName,
        subtitle: filePath,
        icon: <FileIcon name={fileName} />,
        action: async () => {
          const existing = tabs.find((t) => t.path === filePath || t.name === fileName);
          if (existing) {
            setActiveTab(existing.id);
          } else {
            const opened = await WorkspaceService.readFile(filePath);
            openFile(opened);
          }
          setSplitTab("editor");
          setSplitOpen(true);
          onClose();
        },
      });
    });

    // 5. Settings & Tools
    items.push(
      {
        id: "settings-open",
        category: "Settings",
        type: "settings",
        title: "Open Studio Settings",
        subtitle: "Configure local models, VRAM budgets, and providers",
        shortcut: "⌘ ,",
        icon: <Settings className="w-4 h-4 text-gray-400" />,
        action: () => {
          onOpenSettings?.();
          onClose();
        },
      },
      {
        id: "settings-benchmarks",
        category: "Settings",
        type: "settings",
        title: "Open Benchmark Gap Analyzer",
        subtitle: "Measure code completion throughput and quality",
        icon: <Zap className="w-4 h-4 text-amber-400" />,
        action: () => {
          setBenchmarkModalOpen(true);
          onClose();
        },
      },
      {
        id: "settings-skills",
        category: "Settings",
        type: "settings",
        title: "Specialist AI Skills Marketplace",
        subtitle: "Website builder, video editing, and workflow tools",
        icon: <Sparkles className="w-4 h-4 text-purple-400" />,
        action: () => {
          setSkillsModalOpen(true);
          onClose();
        },
      },
      {
        id: "settings-purge-vram",
        category: "Settings",
        type: "settings",
        title: "Purge Unified VRAM & Memory Cache",
        subtitle: "Release Apple Silicon GPU memory buffers",
        icon: <Zap className="w-4 h-4 text-rose-400" />,
        action: () => {
          purgeVRAM();
          onClose();
        },
      }
    );

    return items;
  }, [
    chatSessions,
    files,
    tabs,
    currentProfile,
    switchSession,
    clearEngineSession,
    openBrowserPreview,
    setSplitTab,
    setSplitOpen,
    setProfile,
    setActiveTab,
    openFile,
    onOpenSettings,
    setBenchmarkModalOpen,
    setSkillsModalOpen,
    purgeVRAM,
    onClose,
  ]);

  // Filter items by active tab and search query
  const filteredItems = useMemo(() => {
    let list = allItems;
    if (activeFilter !== "all") {
      list = list.filter((item) => item.type === activeFilter);
    }
    if (!query.trim()) return list;

    const q = query.toLowerCase();
    return list.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
        (item.badge && item.badge.toLowerCase().includes(q))
    );
  }, [allItems, activeFilter, query]);

  // Group filtered items by category
  const groupedItems = useMemo(() => {
    const map = new Map<string, SearchItem[]>();
    for (const item of filteredItems) {
      if (!map.has(item.category)) {
        map.set(item.category, []);
      }
      map.get(item.category)!.push(item);
    }
    return map;
  }, [filteredItems]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, activeFilter]);

  // Cycle filter tabs
  const cycleFilter = (direction: 1 | -1) => {
    const currentIndex = filterTabs.findIndex((t) => t.id === activeFilter);
    const nextIndex = (currentIndex + direction + filterTabs.length) % filterTabs.length;
    setActiveFilter(filterTabs[nextIndex].id);
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredItems.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % Math.max(1, filteredItems.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filteredItems[selectedIndex]) {
          filteredItems[selectedIndex].action();
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        cycleFilter(e.shiftKey ? -1 : 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, filteredItems, selectedIndex, onClose, activeFilter]);

  // Auto focus input on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  let runningItemIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 bg-black/75 backdrop-blur-md p-3 select-none font-sans animate-in fade-in duration-100">
      <div className="w-full max-w-xl bg-[#141720] border border-white/10 rounded-2xl shadow-[0_30px_90px_rgba(0,0,0,0.9)] overflow-hidden flex flex-col">
        {/* ── Top Search Input Header ─────────────────────────────────────── */}
        <div className="flex items-center px-4 py-3 bg-[#0d1017] border-b border-white/5 gap-3">
          <Search className="w-4 h-4 text-[#FF6C37] flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents, Canvas, files, actions..."
            className="w-full bg-transparent text-sm text-white placeholder:text-gray-500 outline-none font-sans"
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="p-1 rounded text-gray-500 hover:text-white"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* ── Category Filter Pills Row ──────────────────────────────────── */}
        <div className="flex items-center gap-1.5 px-4 py-2 bg-[#10131c] border-b border-white/5 overflow-x-auto text-xs">
          {filterTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveFilter(tab.id)}
              className={`px-3 py-1 rounded-lg font-medium transition-all ${
                activeFilter === tab.id
                  ? "bg-[#202738] text-white shadow-sm font-semibold border border-white/10"
                  : "text-gray-400 hover:text-white hover:bg-white/5"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Results List with Grouped Categories ───────────────────────── */}
        <div ref={listRef} className="max-h-96 overflow-y-auto p-2 space-y-3">
          {filteredItems.length === 0 ? (
            <div className="p-10 text-center text-gray-500 text-xs font-mono">
              No matching agents, files, or commands found.
            </div>
          ) : (
            Array.from(groupedItems.entries()).map(([category, items]) => (
              <div key={category} className="space-y-0.5">
                {/* Category Header */}
                <div className="px-3 py-1 text-3xs font-semibold text-gray-500 uppercase tracking-wider">
                  {category}
                </div>

                {/* Items in Category */}
                {items.map((item) => {
                  const currentIndex = runningItemIndex++;
                  const isSelected = currentIndex === selectedIndex;

                  return (
                    <div
                      key={item.id}
                      onClick={() => void item.action()}
                      onMouseEnter={() => setSelectedIndex(currentIndex)}
                      className={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition-all ${
                        isSelected
                          ? "bg-[#1f2438] border border-white/10 text-white shadow-sm"
                          : "text-gray-300 hover:bg-white/5 border border-transparent"
                      }`}
                    >
                      {/* Left: Icon & Title */}
                      <div className="flex items-center gap-3 truncate">
                        <div className="flex-shrink-0">{item.icon}</div>
                        <div className="flex flex-col truncate">
                          <span className="font-medium text-xs truncate text-gray-200">
                            {item.title}
                          </span>
                          {item.subtitle && (
                            <span className="text-3xs text-gray-500 font-mono truncate">
                              {item.subtitle}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Right: Badge / Keyboard Shortcut */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {item.badge && (
                          <span className="text-3xs font-mono text-gray-500 bg-white/5 px-2 py-0.5 rounded border border-white/5">
                            {item.badge}
                          </span>
                        )}
                        {item.shortcut && (
                          <span className="text-3xs font-mono text-gray-400 bg-white/5 px-2 py-0.5 rounded border border-white/10">
                            {item.shortcut}
                          </span>
                        )}
                        {isSelected && !item.shortcut && !item.badge && (
                          <CornerDownLeft className="w-3.5 h-3.5 text-[#FF6C37]" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* ── Footer Navigation Helper ──────────────────────────────────── */}
        <footer className="px-4 py-2 bg-[#0a0c12] border-t border-white/5 flex items-center justify-between text-3xs text-gray-500 font-mono">
          <div className="flex items-center gap-3">
            <span><strong className="text-gray-400">↑↓</strong> Select</span>
            <span><strong className="text-gray-400">↵</strong> Open</span>
            <span><strong className="text-gray-400">Tab</strong> Change Filter</span>
          </div>
          <span>Esc to Close</span>
        </footer>
      </div>
    </div>
  );
};
