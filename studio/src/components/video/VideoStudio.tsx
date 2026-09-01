import React, { useState, useEffect } from "react";
import { 
  Play, 
  Pause, 
  SkipBack, 
  SkipForward, 
  Scissors, 
  Volume2, 
  Music, 
  Sparkles, 
  Film, 
  Sliders, 
  Download, 
  Layers, 
  Wand2, 
  CheckCircle2, 
  Radio,
  RefreshCw,
  Plus
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";
import { MCPRemoteSyncService } from "../../services/mcpRemoteSyncService";

export const VideoStudio: React.FC = () => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(14.2);
  const [duration, setDuration] = useState(45.0);
  const [selectedTrack, setSelectedTrack] = useState<string>("v1");
  const [mcpStatus, setMcpStatus] = useState<"checking" | "connected" | "syncing" | "offline" | "error">("checking");
  const [mcpDetail, setMcpDetail] = useState("Checking Teminali Cut MCP on port 3888");
  const { addMessageToEngine } = useStudioStore();

  const tracks = [
    {
      id: "v1",
      name: "V1 · Main Video Track (4K 60fps)",
      type: "video",
      color: "border-sky-500/40 bg-sky-500/10",
      clips: [
        { id: "c1", title: "Intro_Hook.mp4", start: 0, end: 12.5, color: "bg-[#0284c7]/40 border-[#38bdf8]" },
        { id: "c2", title: "Demo_Walkthrough.mp4", start: 12.5, end: 32.0, color: "bg-[#0284c7]/60 border-[#38bdf8]" },
        { id: "c3", title: "Outro_CTA.mp4", start: 32.0, end: 45.0, color: "bg-[#0284c7]/40 border-[#38bdf8]" },
      ],
    },
    {
      id: "a1",
      name: "A1 · Dialogue & Speech",
      type: "audio",
      color: "border-emerald-500/40 bg-emerald-500/10",
      clips: [
        { id: "a_c1", title: "Voiceover_Clean.wav", start: 0, end: 42.0, color: "bg-[#059669]/40 border-[#10b981]" },
      ],
    },
    {
      id: "a2",
      name: "A2 · Background Music & Beats",
      type: "audio",
      color: "border-purple-500/40 bg-purple-500/10",
      clips: [
        { id: "a_c2", title: "Synthwave_Track_120bpm.mp3", start: 0, end: 45.0, color: "bg-[#7c3aed]/40 border-[#8b5cf6]" },
      ],
    },
    {
      id: "t1",
      name: "T1 · Kinetic Animated Captions",
      type: "subtitle",
      color: "border-amber-500/40 bg-amber-500/10",
      clips: [
        { id: "t_c1", title: "✨ [Kinetic Word Highlight]", start: 2.0, end: 12.0, color: "bg-[#d97706]/40 border-[#f59e0b]" },
        { id: "t_c2", title: "✨ [Neon Glow Subtitle]", start: 14.0, end: 30.0, color: "bg-[#d97706]/40 border-[#f59e0b]" },
      ],
    },
  ];

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const result = await MCPRemoteSyncService.checkConnection();
      if (cancelled || mcpStatus === "syncing") return;
      setMcpStatus(result.connected ? "connected" : "offline");
      setMcpDetail(result.detail);
    };
    void check();
    const interval = window.setInterval(check, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [mcpStatus]);

  const handleAiCutSilence = async () => {
    setMcpStatus("syncing");
    try {
      const result = await MCPRemoteSyncService.splitSilenceAndAlignBpm("A1", -32, 120);
      setMcpStatus("connected");
      setMcpDetail("Last Teminali Cut operation completed with a validated response");
      addMessageToEngine("frontier", {
        role: "assistant",
        content: `Teminali Cut MCP completed the silence operation on ${result.trackId}: ${result.cutsApplied} cuts, ${result.durationSavedSec}s removed, ${result.downbeatsAligned} downbeats aligned.`,
        toolCalls: [
          {
            id: `tool_${Date.now()}`,
            name: "teminali.cut.detect_silence_and_split",
            arguments: { thresholdDb: -32, minSilenceSec: 0.4 },
            status: "completed",
            result: JSON.stringify(result),
          },
        ],
      });
    } catch (error) {
      setMcpStatus("error");
      setMcpDetail(error instanceof Error ? error.message : "Teminali Cut MCP operation failed");
      addMessageToEngine("frontier", {
        role: "assistant",
        content: `Teminali Cut MCP operation failed. No timeline success was recorded.\n\n${error instanceof Error ? error.message : "Unknown failure."}`,
        errorCode: "MCP_OPERATION_FAILED",
      });
    }
  };

  const handleAiBeatSync = async () => {
    setMcpStatus("syncing");
    try {
      const result = await MCPRemoteSyncService.alignCutsToBpm("A2", 120);
      setMcpStatus("connected");
      setMcpDetail("Last Teminali Cut operation completed with a validated response");
      addMessageToEngine("frontier", {
        role: "assistant",
        content: `Teminali Cut MCP aligned ${result.downbeatsAligned} downbeats at ${result.bpm} BPM on ${result.trackId}.`,
        toolCalls: [
          {
            id: `tool_${Date.now()}`,
            name: "teminali.cut.sync_cuts_to_audio_beats",
            arguments: { track: "A2", bpm: 120 },
            status: "completed",
            result: JSON.stringify(result),
          },
        ],
      });
    } catch (error) {
      setMcpStatus("error");
      setMcpDetail(error instanceof Error ? error.message : "Teminali Cut MCP operation failed");
      addMessageToEngine("frontier", {
        role: "assistant",
        content: `Teminali Cut MCP operation failed. No beat-sync success was recorded.\n\n${error instanceof Error ? error.message : "Unknown failure."}`,
        errorCode: "MCP_OPERATION_FAILED",
      });
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#08090b] text-[#dcdfe4] overflow-hidden font-mono select-none">
      {/* Top Video Studio Header Strip */}
      <div className="h-9 px-4 border-b border-[#1c1f26] bg-[#0e1015] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-bold text-white">
            <div className="w-5 h-5 rounded-md bg-gradient-to-br from-[#8b5cf6] to-[#6d28d9] flex items-center justify-center text-3xs font-extrabold text-white shadow-sm border border-white/20">
              TC
            </div>
            <span>Teminali Cut Engine v1.12.5</span>
          </div>
          <span className="text-3xs text-[#5c6370]">|</span>
          <div className="flex items-center gap-1.5 text-2xs text-[#abb2bf]">
            <span className={`w-2 h-2 rounded-full ${mcpStatus === "connected" ? "bg-[#10b981]" : mcpStatus === "syncing" || mcpStatus === "checking" ? "bg-amber-400 animate-pulse" : "bg-rose-500"}`} />
            <span title={mcpDetail}>MCP 3888 · {mcpStatus}</span>
          </div>
        </div>

        {/* AI Action Triggers */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleAiCutSilence}
            disabled={mcpStatus !== "connected"}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-[#0284c7]/20 hover:bg-[#0284c7]/30 text-[#38bdf8] border border-[#38bdf8]/40 text-2xs font-bold transition-all"
          >
            <Scissors className="w-3 h-3" />
            <span>Auto-Cut Silence</span>
          </button>

          <button
            onClick={handleAiBeatSync}
            disabled={mcpStatus !== "connected"}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-[#8b5cf6]/20 hover:bg-[#8b5cf6]/30 text-[#c4b5fd] border border-[#8b5cf6]/40 text-2xs font-bold transition-all"
          >
            <Music className="w-3 h-3" />
            <span>Snap to Beats</span>
          </button>

          <button disabled title="Export requires a verified Teminali Cut export capability" className="flex items-center gap-1.5 px-3 py-1 bg-[#334155] text-slate-400 font-bold text-2xs cursor-not-allowed">
            <Download className="w-3 h-3" />
            <span>Export unavailable</span>
          </button>
        </div>
      </div>

      {/* Center 4K Video Player Canvas */}
      <div className="h-64 border-b border-[#1c1f26] bg-[#050608] flex items-center justify-center relative group">
        <div className="w-[460px] h-[260px] bg-[#0c0d12] border border-[#232833] flex flex-col items-center justify-center relative shadow-2xl overflow-hidden">
          {/* Mock Video Frame */}
          <div className="absolute inset-0 bg-gradient-to-br from-[#0c0d12] via-[#14171f] to-[#08090b] flex flex-col items-center justify-center p-6 text-center">
            <div className="w-12 h-12 bg-[#8b5cf6]/20 border border-[#8b5cf6]/40 text-[#c4b5fd] flex items-center justify-center mb-3">
              <Film className="w-6 h-6 text-[#a78bfa]" />
            </div>
            <h2 className="text-sm font-bold text-white">Commercial Video Project (4K)</h2>
            <p className="text-3xs text-[#5c6370] mt-1">Local UI preview · not live MCP timeline state</p>

            {/* Kinetic Highlight Captions Preview */}
            <div className="mt-4 px-3 py-1 bg-black/80 border border-[#38bdf8]/60 text-xs font-black text-[#38bdf8] shadow-glow">
              ⚡ AUTONOMOUS AI VIDEO EDITING
            </div>
          </div>

          {/* Video Transport Controls Overlay */}
          <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between px-3 py-1.5 bg-[#08090b]/90 border border-[#232833] backdrop-blur-sm text-2xs">
            <div className="flex items-center gap-3">
              <button onClick={() => setCurrentTime(0)} className="hover:text-white text-[#5c6370]"><SkipBack className="w-3.5 h-3.5" /></button>
              <button 
                onClick={() => setIsPlaying(!isPlaying)} 
                className="w-6 h-6 bg-[#38bdf8] hover:bg-[#0ea5e9] text-black flex items-center justify-center font-bold"
              >
                {isPlaying ? <Pause className="w-3 h-3 fill-black" /> : <Play className="w-3 h-3 fill-black" />}
              </button>
              <button onClick={() => setCurrentTime(duration)} className="hover:text-white text-[#5c6370]"><SkipForward className="w-3.5 h-3.5" /></button>
            </div>

            <div className="font-mono text-2xs text-[#abb2bf]">
              <span className="text-[#38bdf8] font-bold">00:14:12</span> / <span className="text-[#5c6370]">00:45:00</span>
            </div>

            <div className="flex items-center gap-2 text-[#5c6370]">
              <Volume2 className="w-3.5 h-3.5" />
              <span className="text-3xs">100%</span>
            </div>
          </div>
        </div>
      </div>

      {/* Multi-Track Timeline Canvas */}
      <div className="flex-1 flex flex-col overflow-hidden bg-[#08090b]">
        {/* Timeline Ruler & Playhead */}
        <div className="h-6 border-b border-[#1c1f26] bg-[#0c0d12] flex items-center px-4 justify-between text-3xs font-mono text-[#5c6370]">
          <div className="flex items-center gap-12">
            <span>00:00:00</span>
            <span>00:10:00</span>
            <span>00:20:00</span>
            <span>00:30:00</span>
            <span>00:40:00</span>
            <span>00:45:00</span>
          </div>
          <span className="text-[#38bdf8] font-bold">SNAPPING: ON</span>
        </div>

        {/* Tracks List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5 font-mono text-2xs">
          {tracks.map((track) => (
            <div key={track.id} className={`p-2 border \${track.color} space-y-1.5`}>
              <div className="flex items-center justify-between text-3xs text-[#abb2bf] font-bold">
                <span>{track.name}</span>
                <span className="text-[#5c6370]">{track.clips.length} Clips</span>
              </div>

              {/* Clip Blocks in Track */}
              <div className="h-8 bg-[#090a0d] border border-[#232833] flex items-center p-1 gap-1 relative overflow-hidden">
                {track.clips.map((clip) => (
                  <div
                    key={clip.id}
                    className={`h-full flex items-center px-2 text-3xs font-bold text-white border \${clip.color} shadow-sm truncate cursor-pointer hover:brightness-125 transition-all`}
                    style={{ flex: clip.end - clip.start }}
                  >
                    {clip.title}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
