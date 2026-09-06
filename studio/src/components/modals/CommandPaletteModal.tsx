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
  Sparkle,
  FileText,
  CornerDownLeft,
  X,
  Sliders,
} from "lucide-react";
import { useStudioStore, ChatSession } from "../../store/studioStore";
import { WorkspaceService } from "../../services/workspaceService";
import { FileIcon } from "../sidebar/FileTree";
import { IconButton, Kbd, Modal, SectionLabel, SegmentedTabs } from "../ui";
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
        // The workspace is already the subtitle beside the title. Only the age
        // is genuinely a column, so only the age goes right.
        badge: session.timestamp,
        icon: <Bot className="w-4 h-4" />,
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
        icon: <ArrowLeft className="w-4 h-4 text-ink-muted" />,
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
        icon: <ArrowRight className="w-4 h-4 text-ink-muted" />,
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
        icon: <Bot className="w-4 h-4" />,
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
        icon: <Mic className="w-4 h-4 text-warning" />,
        action: () => {
          onClose();
        },
      },
      {
        id: "action-pin-agent",
        category: "Agent",
        type: "actions",
        title: "Pin / Unpin Agent",
        icon: <Pin className="w-4 h-4 text-ink-muted" />,
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
        icon: <Globe className="w-4 h-4" />,
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
        icon: <Terminal className="w-4 h-4 text-success" />,
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
        icon: <Sliders className="w-4 h-4 text-reason" />,
        action: () => {
          onClose();
        },
      },
      {
        id: "mode-agent",
        category: "Mode",
        type: "actions",
        title: "Agent Mode (Frontier Auto)",
        subtitle: "Autonomous local multi-file coding and tool execution",
        badge: currentProfile === "auto" ? "Active" : undefined,
        icon: <Zap className="w-4 h-4" />,
        action: () => {
          setProfile("auto");
          onClose();
        },
      },
      {
        id: "mode-flash",
        category: "Mode",
        type: "actions",
        title: "Flash Mode (Frontier Flash)",
        subtitle: "Ultra-fast local generation with low memory footprint",
        badge: currentProfile === "flash" ? "Active" : undefined,
        icon: <Sparkle className="w-4 h-4 text-success" />,
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
        icon: <Settings className="w-4 h-4 text-ink-muted" />,
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
        icon: <Zap className="w-4 h-4 text-warning" />,
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
        icon: <Sparkle className="w-4 h-4 text-reason" />,
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
        icon: <Zap className="w-4 h-4 text-danger" />,
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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      // No header: the field *is* the header, and a modal that closes on Esc,
      // on the backdrop and on picking something does not also need a button —
      // one red dot floating over a search field is decorative colour (§1.3).
      showCloseButton={false}
      bodyClassName="flex flex-col min-h-0"
      footer={
        <div className="flex items-center justify-between w-full text-2xs text-ink-faint">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5"><Kbd>↑↓</Kbd> Select</span>
            <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> Open</span>
            <span className="flex items-center gap-1.5"><Kbd>Tab</Kbd> Change filter</span>
          </div>
          <span className="flex items-center gap-1.5"><Kbd>Esc</Kbd> Close</span>
        </div>
      }
    >
      {/* ── The field is the header ──────────────────────────────────────── */}
      <div className="lit-focus flex items-center gap-2.5 px-4 h-12 border-b border-edge flex-shrink-0">
        <Search className="w-4 h-4 text-ink-faint flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents, files, actions…"
          className="w-full bg-transparent text-sm text-ink-bright placeholder:text-ink-placeholder outline-none"
          spellCheck={false}
        />
        {query && (
          <IconButton size={22} title="Clear" onClick={() => setQuery("")}>
            <X size={12} />
          </IconButton>
        )}
      </div>

      {/* One tab switcher, the shared one — never a row of hand-rolled pills (§2). */}
      <div className="px-3 py-2 border-b border-edge flex-shrink-0">
        <SegmentedTabs
          variant="underline"
          activeTab={activeFilter}
          onChange={setActiveFilter}
          tabs={filterTabs}
        />
      </div>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-1.5 max-h-[min(58vh,480px)]">
        {filteredItems.length === 0 ? (
          <p className="py-12 text-center text-xs text-ink-placeholder">
            Nothing here matches {query ? `“${query}”` : "that"}.
          </p>
        ) : (
          Array.from(groupedItems.entries()).map(([category, items]) => (
            <section key={category}>
              <SectionLabel>{category}</SectionLabel>
              {items.map((item) => {
                const currentIndex = runningItemIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  /*
                    A row, not a card. Every one of these used to be a `lit`
                    hairline box with a shadow — twenty bordered rectangles
                    stacked in a column, which is a form rather than a list.
                    The selection is a flat wash; the border does no work here
                    because there is nothing to enclose.

                    One line, because the second one was the workspace and the
                    workspace is right there beside the title. What goes right
                    is only what is genuinely a column: the age, the shortcut,
                    or the return arrow that says this is the one Enter opens.
                  */
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => void item.action()}
                    onMouseEnter={() => setSelectedIndex(currentIndex)}
                    className={`w-full h-8 flex items-center gap-2.5 px-3.5 text-left transition-colors duration-ds ease-ds ${
                      isSelected ? "bg-surface-hover" : "hover:bg-surface-chip"
                    }`}
                  >
                    <span className={`w-4 flex-shrink-0 flex items-center justify-center ${isSelected ? "text-ink-high" : "text-ink-faint"}`}>
                      {item.icon}
                    </span>
                    <span className="text-xs text-ink-high truncate">{item.title}</span>
                    {item.subtitle && (
                      <span className="text-2xs text-ink-faint truncate">{item.subtitle}</span>
                    )}
                    <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                      {item.badge && (
                        <span className="text-2xs text-ink-disabled tabular-nums">{item.badge}</span>
                      )}
                      {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                      {isSelected && !item.shortcut && (
                        <CornerDownLeft className="w-3 h-3 text-accent" />
                      )}
                    </span>
                  </button>
                );
              })}
            </section>
          ))
        )}
      </div>
    </Modal>
  );
};
