import React from "react";
import { GitBranch, AlertCircle, Check, User, ExternalLink, Terminal, Users, Sparkles, Bell } from "lucide-react";

export const StatusBar: React.FC<{ isTerminalOpen: boolean; toggleTerminal: () => void }> = ({ isTerminalOpen, toggleTerminal }) => {
  return (
    <footer className="h-6 bg-[#0c0d10] border-t border-[#1c1f26] px-3 flex items-center justify-between text-3xs select-none z-40 font-mono text-[#757b85] flex-shrink-0 overflow-hidden whitespace-nowrap">
      {/* Left Items */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <button className="flex items-center gap-1 text-[#abb2bf] hover:text-white">
          <User className="w-3 h-3 text-[#38bdf8]" />
        </button>

        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-[#757b85]">
            <AlertCircle className="w-3 h-3" /> 0
          </span>
          <span className="flex items-center gap-1 text-[#757b85]">
            <AlertCircle className="w-3 h-3" /> 0
          </span>
        </div>

        <button className="flex items-center gap-1 text-[#abb2bf] hover:text-white">
          <GitBranch className="w-3 h-3 text-[#38bdf8]" />
          <span>main</span>
        </button>

        <button 
          onClick={toggleTerminal}
          className={`flex items-center gap-1 px-1.5 py-0.2 rounded ${isTerminalOpen ? "text-[#38bdf8] bg-[#38bdf8]/10" : "text-[#757b85] hover:text-white"}`}
        >
          <Terminal className="w-2.5 h-2.5" />
          <span>zsh</span>
        </button>
      </div>

      {/* Center: Editor Identity */}
      <div className="hidden md:flex items-center gap-2 text-3xs px-2">
        <span className="text-[#757b85]">Editor:</span>
        <span className="px-1.5 py-0.5 bg-[#38bdf8]/15 text-[#38bdf8] font-bold border border-[#38bdf8]/30 rounded-sm flex items-center gap-1">
          <Sparkles className="w-2.5 h-2.5 text-[#38bdf8]" />
          <span>FRONTIER CODE (Default)</span>
        </span>
        <span className="text-[#757b85]">|</span>
        <button 
          onClick={() => window.open("vscode://file//Users/teminali/Documents/my_projects/frontier")}
          className="text-[#abb2bf] hover:text-white hover:underline flex items-center gap-1"
        >
          VS Code <ExternalLink className="w-2.5 h-2.5" />
        </button>
      </div>

      {/* Right Items (Matching exact screenshot: Google + Users + Spark Badge + Prettier + Bell) */}
      <div className="flex items-center gap-3 flex-shrink-0 text-xs font-sans">
        <button className="flex items-center gap-1.5 text-[#abb2bf] hover:text-white text-3xs font-mono">
          <User className="w-3 h-3 text-[#8b929e]" />
          <span>Sign in to Google</span>
        </button>

        <button className="text-[#8b929e] hover:text-white">
          <Users className="w-3.5 h-3.5" />
        </button>

        {/* Yellow Active Sync Spark Badge from Screenshot */}
        <div className="px-1.5 py-0.5 bg-[#ca8a04] text-black font-bold rounded flex items-center justify-center">
          <Sparkles className="w-3 h-3 fill-black text-black" />
        </div>

        <button className="flex items-center gap-1 text-[#abb2bf] hover:text-white text-3xs font-mono">
          <Check className="w-3 h-3 text-[#10b981]" />
          <span>Prettier</span>
        </button>

        <button className="text-[#8b929e] hover:text-white">
          <Bell className="w-3.5 h-3.5" />
        </button>
      </div>
    </footer>
  );
};
