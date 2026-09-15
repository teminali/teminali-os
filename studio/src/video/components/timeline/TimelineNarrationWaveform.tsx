/**
 * Teminali OS — Video Timeline Narration Waveform Micro-Animations
 *
 * Renders real-time animated waveform micro-bars directly on the video timeline canvas
 * whenever Temi is narrating video edits, summarizing cuts, or speaking aloud.
 *
 * Aesthetic: Premium Cursor-style glassmorphism with emerald/teal (#00bf63 / #2dd4bf) glow.
 */

import React, { useEffect, useRef, useState } from "react";
import { Mic, Volume2 } from "lucide-react";
import { useAssistantActivityStore } from "../../../store/assistantActivityStore";

interface TimelineNarrationWaveformProps {
  className?: string;
}

const BAR_COUNT = 24;

export const TimelineNarrationWaveform: React.FC<TimelineNarrationWaveformProps> = ({
  className = "",
}) => {
  const isTaskRunning = useAssistantActivityStore((s) => s.isTaskRunning);
  const latestProgress = useAssistantActivityStore((s) => s.latestProgress);

  const [bars, setBars] = useState<number[]>(() =>
    Array.from({ length: BAR_COUNT }, () => 4)
  );

  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    let phase = 0;

    const animate = () => {
      phase += isTaskRunning ? 0.18 : 0.04;
      const newBars = Array.from({ length: BAR_COUNT }, (_, i) => {
        const primary = Math.sin(phase + i * 0.4);
        const secondary = Math.cos(phase * 0.7 + i * 0.25);
        const combined = (primary + secondary + 2) / 4; // 0 to 1

        if (isTaskRunning) {
          // Active speaking / narration: dynamic heights between 5px and 22px
          return Math.round(5 + combined * 17);
        } else {
          // Resting state: subtle gentle breathing between 3px and 6px
          return Math.round(3 + combined * 3);
        }
      });

      setBars(newBars);
      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isTaskRunning]);

  return (
    <div
      role="status"
      aria-label={isTaskRunning ? "Temi is narrating video edits" : "Temi narration idle"}
      className={`pointer-events-auto flex items-center gap-2 rounded-full border border-[#2d2d2d] bg-[#121212]/90 px-3 py-1 text-xs text-zinc-300 shadow-md backdrop-blur-md transition-all duration-300 ${
        isTaskRunning
          ? "border-[#00bf63]/40 shadow-[0_0_12px_rgba(0,191,99,0.2)]"
          : "opacity-80 hover:opacity-100"
      } ${className}`}
    >
      {/* Icon & Status */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {isTaskRunning ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00bf63] opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#00bf63]" />
          </span>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
        )}

        <div className="flex items-center gap-1 font-medium text-[11px] text-zinc-200">
          {isTaskRunning ? (
            <Volume2 size={12} className="text-[#00bf63] animate-pulse" />
          ) : (
            <Mic size={12} className="text-zinc-500" />
          )}
          <span className="tracking-tight">
            {isTaskRunning ? "Temi Narrating" : "Temi Voice"}
          </span>
        </div>
      </div>

      {/* Waveform Micro-Bars */}
      <div
        className="flex items-center gap-[2px] h-5 px-1 select-none"
        title={isTaskRunning ? "Temi active speech waveform" : "Waveform idle"}
      >
        {bars.map((height, idx) => (
          <span
            key={idx}
            style={{ height: `${height}px` }}
            className={`w-[2px] rounded-full transition-all duration-75 ${
              isTaskRunning
                ? idx % 2 === 0
                  ? "bg-[#00bf63]"
                  : "bg-[#2dd4bf]"
                : "bg-zinc-600"
            }`}
          />
        ))}
      </div>

      {/* Optional short narration caption ticker */}
      {isTaskRunning && latestProgress && (
        <span className="max-w-[180px] truncate text-[10.5px] text-zinc-400 font-mono">
          {latestProgress}
        </span>
      )}
    </div>
  );
};
