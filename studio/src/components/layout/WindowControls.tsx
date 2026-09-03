import React, { useEffect, useState } from "react";

import type { RecorderBridge } from "../../types/recorder";

interface TeminaliBridge {
  isElectron: boolean;
  platform: string;
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (listener: (isMaximized: boolean) => void) => () => void;
  };
  projects: {
    chooseFolder: () => Promise<string | null>;
    setRecent: (projects: Array<{ path: string; name: string }>) => Promise<void>;
  };
  menu: {
    on: (channel: string, listener: (payload?: unknown) => void) => () => void;
  };
  /** Present only in the desktop shell; the web build cannot install anything. */
  updates?: {
    install: (filePath: string) => Promise<{ ok: boolean; reason?: string }>;
    restart: () => Promise<boolean>;
  };
  /**
   * Screen recording. Optional for the same reason as the assistant: a
   * browser build has no bridge, and the recorder falls back to
   * `getDisplayMedia` rather than pretending the source grid, the
   * floating bar and the global shortcuts exist.
   */
  recorder?: RecorderBridge;
  /**
   * The screen assistant. Optional because a browser build has no bridge at
   * all, and the assistant degrades to the in-window panel rather than
   * pretending the shortcut and the menu bar item exist.
   */
  assistant?: {
    onCommand: (listener: (payload: AssistantBridgeCommand) => void) => () => void;
    setState: (state: Record<string, unknown>) => Promise<boolean>;
    setHotkey: (accelerator: string) => Promise<AssistantHotkeyStatus>;
    hotkeyStatus: () => Promise<AssistantHotkeyStatus>;
    showOverlay: (state: Record<string, unknown>) => Promise<boolean>;
    hideOverlay: () => Promise<boolean>;
    overlayState: () => Promise<Record<string, unknown>>;
    /**
     * Open the Screen Recording list and reveal the bundle to drag into it.
     * Not a request for the permission: macOS has no prompt for this one.
     */
    revealForScreenRecording: () => Promise<{
      ok: boolean;
      bundlePath?: string;
      isDevelopmentBundle?: boolean;
      reason?: string;
    }>;
    onOverlay: (listener: (state: Record<string, unknown>) => void) => () => void;
  };
}

/** What the hotkey and the menu bar item can ask the renderer to do. */
export interface AssistantBridgeCommand {
  activate?: boolean;
  mode?: string;
  autonomy?: string;
  engine?: string;
  frontierMode?: string;
  speak?: boolean;
  overlay?: boolean;
}

export interface AssistantHotkeyStatus {
  accelerator: string;
  registered: boolean;
  reason: string | null;
}

declare global {
  interface Window {
    teminali?: TeminaliBridge;
  }
}

export const isDesktopShell = (): boolean => Boolean(window.teminali?.isElectron);

type LightTone = "close" | "minimize" | "zoom";

const TONES: Record<LightTone, { base: string; top: string; edge: string; glyph: string; glow: string }> = {
  close:    { base: "#ff5f57", top: "var(--danger)", edge: "var(--danger)", glyph: "#5c0d08", glow: "rgba(255,95,87,.55)" },
  minimize: { base: "#febc2e", top: "var(--warning)", edge: "var(--warning)", glyph: "#603d02", glow: "rgba(254,188,46,.55)" },
  zoom:     { base: "#28c840", top: "var(--success)", edge: "var(--success)", glyph: "#0a4715", glow: "rgba(40,200,64,.55)" },
};

interface LightProps {
  tone: LightTone;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

const Light: React.FC<LightProps> = ({ tone, label, onClick, children }) => {
  const colors = TONES[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="group/light relative w-3 h-3 rounded-full grid place-items-center transition-transform duration-100 active:scale-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
      style={{
        // Depth: a lit top edge over a deeper body, ringed so it reads on any surface.
        background: `radial-gradient(circle at 50% 28%, ${colors.top} 0%, ${colors.base} 62%, ${colors.edge} 100%)`,
        boxShadow: `inset 0 .5px 0 rgba(255,255,255,.45), inset 0 0 0 .5px ${colors.edge}, 0 1px 2px rgba(0,0,0,.45)`,
      }}
    >
      {/* Glyphs stay hidden until the cluster is hovered, as on macOS. */}
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className="w-full h-full opacity-0 transition-opacity duration-120 group-hover/controls:opacity-100"
        style={{ color: colors.glyph }}
      >
        {children}
      </svg>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -inset-1 rounded-full opacity-0 group-hover/light:opacity-100 transition-opacity duration-150"
        style={{ boxShadow: `0 0 10px 1px ${colors.glow}` }}
      />
    </button>
  );
};

/**
 * The app's own window controls, drawn because the shell runs frameless.
 * Renders nothing in a browser tab, where the browser supplies its own chrome.
 */
export const WindowControls: React.FC<{ className?: string }> = ({ className = "" }) => {
  const bridge = window.teminali;
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFocused, setIsFocused] = useState(true);

  useEffect(() => {
    if (!bridge) return;
    void bridge.window.isMaximized().then(setIsMaximized).catch(() => {});
    return bridge.window.onMaximizeChange(setIsMaximized);
  }, [bridge]);

  // macOS dims the lights when the window loses focus; matching that keeps the
  // chrome honest about which window is active.
  useEffect(() => {
    const focus = () => setIsFocused(true);
    const blur = () => setIsFocused(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, []);

  if (!bridge) return null;

  const stroke = {
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    fill: "none",
  };

  return (
    <div
      className={`group/controls flex items-center gap-2 pl-1 pr-1 transition-opacity duration-200 ${
        isFocused ? "opacity-100" : "opacity-45"
      } ${className}`}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <Light tone="close" label="Close window" onClick={() => void bridge.window.close()}>
        <path d="M4.2 4.2l3.6 3.6M7.8 4.2l-3.6 3.6" {...stroke} />
      </Light>

      <Light tone="minimize" label="Minimize window" onClick={() => void bridge.window.minimize()}>
        <path d="M3.9 6h4.2" {...stroke} />
      </Light>

      <Light
        tone="zoom"
        label={isMaximized ? "Restore window" : "Maximize window"}
        onClick={() => void bridge.window.toggleMaximize().then(setIsMaximized)}
      >
        {isMaximized ? (
          // Restore: two arrows folding inward.
          <path d="M7.6 4.4L5.2 6.8M7.6 4.4H5.9M7.6 4.4v1.7M4.4 7.6l2.4-2.4M4.4 7.6h1.7M4.4 7.6V5.9" {...stroke} />
        ) : (
          // Zoom: two arrows pushing outward.
          <path d="M4.3 7.7l3.4-3.4M4.3 7.7V6M4.3 7.7H6M7.7 4.3V6M7.7 4.3H6" {...stroke} />
        )}
      </Light>
    </div>
  );
};
