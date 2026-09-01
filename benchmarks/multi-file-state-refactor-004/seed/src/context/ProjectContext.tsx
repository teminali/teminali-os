import React, { createContext, useContext, useState } from "react";

export interface ProjectData {
  id: string;
  title: string;
  fps: number;
  width: number;
  height: number;
}

interface ProjectContextType {
  project: ProjectData;
  updateTitle: (title: string) => void;
  updateResolution: (w: number, h: number) => void;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [project, setProject] = useState<ProjectData>({
    id: "proj_01",
    title: "Untitled Commercial",
    fps: 60,
    width: 3840,
    height: 2160,
  });

  const updateTitle = (title: string) => setProject(p => ({ ...p, title }));
  const updateResolution = (width: number, height: number) => setProject(p => ({ ...p, width, height }));

  return (
    <ProjectContext.Provider value={{ project, updateTitle, updateResolution }}>
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = () => {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within ProjectProvider");
  return ctx;
};
