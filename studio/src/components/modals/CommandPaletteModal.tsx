import React, { useState, useEffect, useMemo } from "react";
import { 
  Search, 
  FileCode2, 
  Sparkles, 
  Terminal, 
  Settings, 
  Radio, 
  Zap, 
  ArrowRight,
  Code2
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";
import { WorkspaceService } from "../../services/workspaceService";
import type { FileItem } from "../../types";

interface PaletteItem {
  id: string;
  type: "file" | "symbol" | "action";
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  action: () => void | Promise<void>;
}

function flattenFiles(items: FileItem[]): FileItem[] {
  return items.flatMap((item) => item.type === "file" ? [item] : flattenFiles(item.children || []));
}

function languageFor(path: string) {
  if (/\.tsx?$/.test(path)) return "typescript";
  if (/\.[cm]?jsx?$/.test(path)) return "javascript";
  if (/\.json$/.test(path)) return "json";
  if (/\.html?$/.test(path)) return "html";
  if (/\.css$/.test(path)) return "css";
  if (/\.md$/.test(path)) return "markdown";
  return "plaintext";
}

export const CommandPaletteModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { 
    tabs, 
    setActiveTab, 
    openFile, 
    setNearbyMeshOpen, 
    setSkillsModalOpen, 
    setBenchmarkModalOpen, 
    purgeVRAM,
    files,
  } = useStudioStore();

  const allItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    // 1. Files in workspace
    flattenFiles(files).forEach((file) => {
      const filePath = file.path;
      const fileName = filePath.split("/").pop() || filePath;
      items.push({
        id: `file-${filePath}`,
        type: "file",
        title: fileName,
        subtitle: filePath,
        icon: <FileCode2 className="w-4 h-4 text-cyan-400" />,
        action: async () => {
          const existing = tabs.find((t) => t.path === filePath || t.name === fileName);
          if (existing) {
            setActiveTab(existing.id);
          } else {
            const opened = await WorkspaceService.readFile(filePath);
            openFile({ ...opened, language: languageFor(filePath) });
          }
          onClose();
        },
      });
    });

    // 2. Actions & Tools
    items.push(
      {
        id: "action-mesh",
        type: "action",
        title: "Share GPU Power via Nearby Mesh",
        subtitle: "P2P local network compute relay",
        icon: <Radio className="w-4 h-4 text-cyan-400" />,
        action: () => {
          setNearbyMeshOpen(true);
          onClose();
        },
      },
      {
        id: "action-benchmarks",
        type: "action",
        title: "Open Benchmark Gap Analyzer",
        subtitle: "Measure frontier code throughput and capability",
        icon: <Zap className="w-4 h-4 text-amber-400" />,
        action: () => {
          setBenchmarkModalOpen(true);
          onClose();
        },
      },
      {
        id: "action-skills",
        type: "action",
        title: "Specialist AI Skills Marketplace",
        subtitle: "Install domain agents & skills",
        icon: <Sparkles className="w-4 h-4 text-purple-400" />,
        action: () => {
          setSkillsModalOpen(true);
          onClose();
        },
      },
      {
        id: "action-vram",
        type: "action",
        title: "Purge Unified VRAM Memory",
        subtitle: "Free Apple Silicon memory cache",
        icon: <Zap className="w-4 h-4 text-red-400" />,
        action: () => {
          purgeVRAM();
          onClose();
        },
      }
    );

    return items;
  }, [tabs, files, onClose, setActiveTab, openFile, setNearbyMeshOpen, setSkillsModalOpen, setBenchmarkModalOpen, purgeVRAM]);

  const filteredItems = useMemo(() => {
    if (!query.trim()) return allItems.slice(0, 10);
    const q = query.toLowerCase();
    return allItems
      .filter((item) => item.title.toLowerCase().includes(q) || (item.subtitle && item.subtitle.toLowerCase().includes(q)))
      .slice(0, 12);
  }, [allItems, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

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
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, filteredItems, selectedIndex, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-100 font-sans">
      <div className="w-full max-w-xl bg-[#141720] border border-white/[0.12] rounded-2xl shadow-[0_25px_70px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col">
        {/* Search Header */}
        <div className="flex items-center px-4 py-3 border-b border-white/[0.08] bg-[#0f121a]">
          <Search className="w-4 h-4 text-cyan-400 mr-3 flex-shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a file name, @symbol, or >action..."
            className="w-full bg-transparent text-sm text-white placeholder-slate-500 outline-none font-mono"
            autoFocus
          />
          <span className="text-[10px] font-mono text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded border border-white/[0.06] flex-shrink-0">
            ESC to close
          </span>
        </div>

        {/* Items List */}
        <div className="max-h-80 overflow-y-auto p-2 space-y-1">
          {filteredItems.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-xs font-mono">
              No matching files or commands found.
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const isSelected = index === selectedIndex;
              return (
                <div
                  key={item.id}
                  onClick={() => void item.action()}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition-all ${
                    isSelected
                      ? "bg-[#1c2230] border border-white/[0.10] text-white shadow"
                      : "text-slate-300 hover:bg-white/[0.04]"
                  }`}
                >
                  <div className="flex items-center gap-3 truncate">
                    <div className="flex-shrink-0">{item.icon}</div>
                    <div className="flex flex-col truncate">
                      <span className="font-semibold text-xs tracking-tight truncate">{item.title}</span>
                      {item.subtitle && (
                        <span className="text-[10px] text-slate-500 font-mono truncate">{item.subtitle}</span>
                      )}
                    </div>
                  </div>
                  <ArrowRight className={`w-3.5 h-3.5 flex-shrink-0 transition-opacity ${isSelected ? "opacity-100 text-cyan-400" : "opacity-0"}`} />
                </div>
              );
            })
          )}
        </div>

        {/* Footer shortcuts */}
        <div className="px-4 py-2 bg-[#0a0d13] border-t border-white/[0.06] flex items-center justify-between text-[10px] text-slate-500 font-mono">
          <div className="flex items-center gap-3">
            <span><strong className="text-slate-400">↑↓</strong> Navigate</span>
            <span><strong className="text-slate-400">↵</strong> Select</span>
          </div>
          <span>Frontier Quick Discovery</span>
        </div>
      </div>
    </div>
  );
};
