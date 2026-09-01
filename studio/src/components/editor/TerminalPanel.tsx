import React, { useState } from "react";
import { X, Trash2, Plus, ChevronDown, SplitSquareVertical, Minus } from "lucide-react";

interface TerminalPanelProps {
  isOpen: boolean;
  height?: number;
  onClose: () => void;
  onResizeStart?: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ 
  isOpen, 
  height = 220, 
  onClose,
  onResizeStart 
}) => {
  const [logs, setLogs] = useState<string[]>([
    "npm run benchmark:start-sonnet -- \\",
    "/var/folders/4m/x6x_6_gd7_n_cg7y8dclghbr0000gn/T/frontier-benchmark-001-vephFW/opencode-sonnet5",
    "teminali@Yohanas-MacBook-Pro opencode-agent-lab %",
    "/private/var/folders/4m/x6x_6_gd7_n_cg7y8dclghbr0000gn/T/frontier-benchmark-001-vephFW/antigravity-gemini37",
    "zsh: permission denied: /private/var/folders/4m/x6x_6_gd7_n_cg7y8dclghbr0000gn/T/frontier-benchmark-001-vephFW/antigravity-gemini37",
    "teminali@Yohanas-MacBook-Pro opencode-agent-lab % cd /private/var/folders/4m/x6x_6_gd7_n_cg7y8dclghbr0000gn/T/frontier-benchmark-001-vephFW/antigravity-gemini37",
    "teminali@Yohanas-MacBook-Pro antigravity-gemini37 % open -a \x27Antigravity IDE\x27 .",
    "teminali@Yohanas-MacBook-Pro antigravity-gemini37 % ",
  ]);

  if (!isOpen) return null;

  return (
    <div 
      style={{ height: `${height}px`, minHeight: 120, maxHeight: "calc(100% - 120px)" }} 
      className="border-t border-[#1c1f26] bg-[#08090b] flex flex-col select-none z-20 text-[#abb2bf] font-mono relative flex-shrink-0"
    >
      {/* Top Drag Resize Handle */}
      {onResizeStart && (
        <div
          role="separator"
          aria-label="Resize terminal panel"
          aria-orientation="horizontal"
          onPointerDown={(e) => {
            e.preventDefault();
            onResizeStart(e);
          }}
          className="h-1.5 w-full cursor-row-resize touch-none hover:bg-[#00f0ff]/40 transition-colors absolute top-0 inset-x-0 z-30 group"
        >
          <div className="h-[1px] w-full bg-[#1c1f26] group-hover:bg-[#00f0ff] transition-colors" />
        </div>
      )}

      {/* Terminal Title Strip */}
      <div className="h-8 border-b border-[#1c1f26] bg-[#0c0d12] flex items-center justify-between px-3 flex-shrink-0">
        <div className="flex items-center gap-2 text-2xs text-[#dcdfe4] font-bold">
          <span className="text-[#00f0ff]">zsh - antigravity-gemini37</span>
          <button className="w-5 h-5 flex items-center justify-center hover:bg-[#1f2430] text-[#5c6370] hover:text-white cursor-pointer"><Plus className="w-3 h-3" /></button>
          <button className="w-5 h-5 flex items-center justify-center hover:bg-[#1f2430] text-[#5c6370] hover:text-white cursor-pointer"><ChevronDown className="w-3 h-3" /></button>
        </div>

        <div className="flex items-center gap-1 text-[#5c6370]">
          <button className="w-6 h-6 flex items-center justify-center hover:bg-[#1f2430] hover:text-white cursor-pointer" title="Clear"><Trash2 className="w-3 h-3" /></button>
          <button className="w-6 h-6 flex items-center justify-center hover:bg-[#1f2430] hover:text-white cursor-pointer" title="Split"><SplitSquareVertical className="w-3 h-3" /></button>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center hover:bg-[#1f2430] hover:text-white cursor-pointer" title="Minimize / Close"><Minus className="w-3 h-3" /></button>
        </div>
      </div>

      {/* Terminal Output */}
      <div className="flex-1 p-3 text-2xs text-[#abb2bf] overflow-y-auto space-y-0.5 select-text leading-tight bg-[#08090b]">
        {logs.map((log, idx) => (
          <div key={idx} className={log.includes("teminali@") ? "text-[#00f0ff] font-bold" : log.includes("denied") ? "text-[#f43f5e]" : ""}>
            {log}
          </div>
        ))}
      </div>
    </div>
  );
};
