/*
 * The desktop bridge's type surface.
 *
 * Despite the name this file draws nothing. It used to hold a second, better
 * set of window controls that no bar ever rendered; those live in
 * `WindowChrome.tsx` now, alongside the Windows and Linux dialects. What it is
 * — and what every importer has always used it for — is the one declaration of
 * `window.teminali`, plus `isDesktopShell`.
 */

import type { RecorderBridge } from "../../types/recorder";
import type { VideoProjectsBridge } from "../../types/videoProjects";
import type { ExporterBridge } from "../../types/exporter";

interface TeminaliBridge {
  isElectron: boolean;
  platform: string;
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    setProgressBar?: (progress: number) => Promise<boolean>;
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
    onInstallProgress?: (listener: (info: { percent: number; status: string }) => void) => () => void;
  };
  /**
   * Screen recording. Optional for the same reason as the assistant: a
   * browser build has no bridge, and the recorder falls back to
   * `getDisplayMedia` rather than pretending the source grid, the
   * floating bar and the global shortcuts exist.
   */
  recorder?: RecorderBridge;
  /**
   * Saving and opening a video project. Optional for the same reason as the
   * recorder: a browser build has no folder dialog and cannot write outside
   * the page, so the editor offers no save there rather than one that fails.
   */
  videoProjects?: VideoProjectsBridge;
  /**
   * Rendering the sequence to a file. Optional for the same reason again: a
   * browser has no ffmpeg and nowhere to write, so the editor offers no
   * Export button there rather than one that opens a dialog and fails.
   */
  exporter?: ExporterBridge;
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
    /** Show or hide the menu bar item; resolves with the settled visibility. */
    setTrayVisible: (visible: boolean) => Promise<boolean>;
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
