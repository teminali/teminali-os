import React, { createContext, useContext, useState } from "react";
import { useProject } from "./ProjectContext";

export interface Clip {
  id: string;
  trackId: string;
  startSec: number;
  durationSec: number;
}

interface TimelineContextType {
  currentTimeSec: number;
  clips: Clip[];
  seek: (time: number) => void;
  addClip: (clip: Clip) => void;
  removeClip: (id: string) => void;
}

const TimelineContext = createContext<TimelineContextType | undefined>(undefined);

export const TimelineProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { project } = useProject();
  const [currentTimeSec, setCurrentTime] = useState(0);
  const [clips, setClips] = useState<Clip[]>([
    { id: "c1", trackId: "V1", startSec: 0, durationSec: 5.2 },
    { id: "c2", trackId: "A1", startSec: 0, durationSec: 5.2 },
  ]);

  const seek = (time: number) => {
    const maxSec = 1000;
    setCurrentTime(Math.max(0, Math.min(time, maxSec)));
  };

  const addClip = (clip: Clip) => setClips(c => [...c, clip]);
  const removeClip = (id: string) => setClips(c => c.filter(item => item.id !== id));

  return (
    <TimelineContext.Provider value={{ currentTimeSec, clips, seek, addClip, removeClip }}>
      {children}
    </TimelineContext.Provider>
  );
};

export const useTimeline = () => {
  const ctx = useContext(TimelineContext);
  if (!ctx) throw new Error("useTimeline must be used within TimelineProvider");
  return ctx;
};
