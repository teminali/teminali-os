import React from "react";
import { 
  FolderOpen, 
  Search, 
  Puzzle, 
  GitBranch, 
  Settings, 
  PanelLeft,
  Crown,
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";

export const ActivityBar: React.FC<{ 
  activeView: string; 
  setActiveView: (v: string) => void;
}> = ({ activeView, setActiveView }) => {
  const { setSkillsModalOpen, setBenchmarkModalOpen } = useStudioStore();

  return (
    <aside className="activity-rail">
      <button 
        onClick={() => setActiveView("explorer")}
        className={`rail-btn ${activeView === "explorer" ? "active" : ""}`}
        aria-label="Files"
        title="Explorer (⌘⇧E)"
      >
        <FolderOpen size={21} />
      </button>

      <button 
        onClick={() => setActiveView("search")}
        className={`rail-btn ${activeView === "search" ? "active" : ""}`}
        aria-label="Search"
        title="Search (⌘⇧F)"
      >
        <Search size={21} />
      </button>

      <button 
        onClick={() => setActiveView("extensions")}
        className={`rail-btn ${activeView === "extensions" ? "active" : ""}`}
        aria-label="Extensions"
        title="Extensions"
      >
        <Puzzle size={21} />
      </button>

      <button 
        onClick={() => setActiveView("source-control")}
        className={`rail-btn ${activeView === "source-control" ? "active" : ""}`}
        aria-label="Git"
        title="Source Control"
      >
        <GitBranch size={21} />
      </button>

      <div className="rail-spacer" />

      <button 
        onClick={() => setBenchmarkModalOpen(true)}
        className="rail-btn crown" 
        aria-label="Premium"
        title="Benchmarks & Pro"
      >
        <Crown size={20} />
      </button>

      <button 
        onClick={() => setSkillsModalOpen(true)}
        className="rail-btn" 
        aria-label="Settings"
        title="Skills & Settings"
      >
        <Settings size={20} />
      </button>

      <button 
        onClick={() => setActiveView(activeView ? "" : "explorer")}
        className="rail-btn" 
        aria-label="Toggle panel"
      >
        <PanelLeft size={18} />
      </button>
    </aside>
  );
};
