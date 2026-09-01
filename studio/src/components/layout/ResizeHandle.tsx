import React, { useState, useEffect, useCallback } from "react";

export interface ResizeHandleProps {
  orientation?: "vertical" | "horizontal";
  onResize: (delta: number) => void;
  onDoubleClick?: () => void;
  className?: string;
  minLimitReached?: boolean;
  maxLimitReached?: boolean;
}

export const ResizeHandle: React.FC<ResizeHandleProps> = ({
  orientation = "vertical",
  onResize,
  onDoubleClick,
  className = "",
  minLimitReached = false,
  maxLimitReached = false,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      const delta = orientation === "vertical" ? e.movementX : e.movementY;
      onResize(delta);
    },
    [isDragging, orientation, onResize]
  );

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
    }
  }, [isDragging]);

  useEffect(() => {
    if (isDragging) {
      document.body.style.cursor = orientation === "vertical" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    } else {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp, orientation]);

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title="Drag to resize · Double-click to reset"
      className={`relative group flex-shrink-0 z-40 transition-colors select-none ${
        orientation === "vertical"
          ? "w-1.5 h-full cursor-col-resize -mx-0.5"
          : "h-1.5 w-full cursor-row-resize -my-0.5"
      } ${className}`}
    >
      {/* Invisible expanded hit target */}
      <div
        className={`absolute inset-0 ${
          orientation === "vertical" ? "-left-1 -right-1" : "-top-1 -bottom-1"
        }`}
      />

      {/* Visible drag indicator line */}
      <div
        className={`w-full h-full transition-all duration-150 ${
          isDragging
            ? "bg-[#38bdf8] shadow-[0_0_8px_#38bdf8]"
            : isHovered
            ? "bg-[#38bdf8]/50"
            : "bg-transparent group-hover:bg-white/10"
        }`}
      />
    </div>
  );
};
