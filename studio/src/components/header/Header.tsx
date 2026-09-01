import React, { useState } from "react";
import { 
  ChevronDown, 
  CircleUserRound
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";
import { useRuntimeTelemetry } from "../../hooks/useRuntimeTelemetry";

export const Header: React.FC<{ mode: "code" | "preview"; setMode: (mode: "code" | "preview") => void }> = ({ mode, setMode }) => {
  const { activeWorkspaceId } = useStudioStore();
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<"idle" | "copied" | "error">("idle");
  const { health, telemetry } = useRuntimeTelemetry();

  const throughput = telemetry?.outputTokensPerSec === null || telemetry?.outputTokensPerSec === undefined
    ? "— tok/s"
    : `${telemetry.outputTokensPerSec.toFixed(1)} tok/s`;
  const ttft = telemetry?.timeToFirstTokenMs === null || telemetry?.timeToFirstTokenMs === undefined
    ? "No sample"
    : `${telemetry.timeToFirstTokenMs.toFixed(0)}ms TTFT`;
  const statusColor = health.state === "healthy"
    ? "bg-emerald-400"
    : health.state === "degraded"
      ? "bg-amber-400"
      : health.state === "checking"
        ? "bg-slate-400"
        : "bg-rose-500";
  const runtimeSummary = health.state === "checking"
    ? "Checking local services"
    : `${health.ollama.detail}; ${health.teminaliCutMcp.detail}`;

  const handleInvite = () => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setInviteStatus("copied");
      setTimeout(() => setInviteStatus("idle"), 2000);
    }).catch(() => {
      setInviteStatus("error");
      setTimeout(() => setInviteStatus("idle"), 2000);
    });
  };

  return (
    <header className="topbar">
      {/* Compact TC logo mark and Teminali Code wordmark. */}
      <div className="brand flex items-center gap-2">
        <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#38bdf8] via-[#0284c7] to-[#0369a1] text-white font-extrabold flex items-center justify-center text-xs border border-white/20 shadow-md">
          TC
        </div>
        <strong className="text-white font-bold tracking-tight">Teminali Studio</strong>
      </div>

      {/* 2. Exact Project Picker Dropdown */}
      <div className="workspace-picker-wrap relative">
        <button 
          onClick={() => setIsWorkspaceOpen(!isWorkspaceOpen)}
          className="project-picker"
          aria-expanded={isWorkspaceOpen}
          aria-haspopup="menu"
        >
          <span>{activeWorkspaceId === "teminali" ? "Teminali" : activeWorkspaceId}</span>
          <ChevronDown size={14} />
        </button>

        {isWorkspaceOpen && (
          <div className="absolute left-0 top-full mt-2 w-56 bg-[#141720] border border-white/[0.10] rounded-xl shadow-2xl p-1.5 z-50 animate-in fade-in duration-100 font-sans">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Workspace
            </div>
            <button
              onClick={() => {
                setIsWorkspaceOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-xs rounded-lg bg-cyan-500/20 text-cyan-400 font-semibold transition-all"
            >
              📁 teminali (Unified Root)
            </button>
          </div>
        )}
      </div>

      {/* Two truthful workspace surfaces: Preview includes file preview and Browser. */}
      <nav className="mode-switch" aria-label="View mode">
        {(["preview", "code"] as const).map((item) => (
          <button 
            key={item}
            className={mode === item ? "active" : ""} 
            onClick={() => setMode(item)}
          >
            {item === "preview" ? "Preview" : "Code"}
          </button>
        ))}
      </nav>

      {/* 4. Exact Top Actions: Live Speed Tachometer + Green Dot + Profile + Invite */}
      <div className="top-actions">
        <div className="runtime-telemetry flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-black/40 border border-cyan-500/30 text-[10px] font-mono shadow-sm" title={`Measured runtime telemetry · ${health.ollama.detail}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
          <span className="text-cyan-400 font-bold">{throughput}</span>
          <span className="text-slate-500">•</span>
          <span className="text-emerald-400 font-semibold">{ttft}</span>
        </div>

        <div className={`runtime-health w-2.5 h-2.5 rounded-full ${statusColor}`} title={`Runtime ${health.state}: ${runtimeSummary}`} />

        {/* Profile Circle */}
        <div className="profile">
          <CircleUserRound size={22} fill="#d4d9dc" color="#f3f4f6" />
        </div>

        {/* Blue Invite Button */}
        <button onClick={handleInvite} className="invite">
          {inviteStatus === "copied" ? "Copied!" : inviteStatus === "error" ? "Copy failed" : "Invite"}
        </button>
      </div>
    </header>
  );
};
