import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { AssistantOverlaySurface } from "./components/assistant/AssistantOverlaySurface";
import { RecorderBar } from "./components/recorder/RecorderBar";
import { useStudioStore } from "./store/studioStore";
import { registerVideoToolBridge } from "./services/videoToolBridge";

/**
 * Which surface this document is.
 *
 * Electron mounts the assistant's drawing layer in its own transparent window
 * pointed at this same bundle with `?surface=overlay`. Branching here rather
 * than shipping a second HTML file is what lets that layer be ordinary React
 * against the ordinary token sheet — a hand-written overlay page would have
 * needed its own copy of every colour, and a copy of the token sheet drifts.
 *
 * The recorder's floating bar is the same trick under a different key:
 * `openBar()` in `electron/screenRecorder.cjs` loads this bundle with
 * `?window=recorder-bar`. It is a separate parameter rather than a third
 * `surface` value because the two windows are opened by unrelated features and
 * a shared key would let one rename break the other.
 */
const params = new URLSearchParams(window.location.search);
const surface = params.get("surface");
const windowKind = params.get("window");

// Electron runs with titleBarStyle "hiddenInset", so the native macOS traffic
// lights float over the app's own chrome. Reserve a drag strip for them instead
// of letting them clip the sidebar header.
if (/Electron/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("is-electron");
  if (/Mac/i.test(navigator.platform)) document.documentElement.classList.add("is-electron-mac");
}


if (typeof window !== "undefined") {
  (window as unknown as { __studioStore: typeof useStudioStore }).__studioStore = useStudioStore;
}

/*
  The video panel's MCP bridge, for the agent CLIs.

  Registered at boot rather than when the panel mounts: the tools act on the
  timeline stores, which are seeded at module load, so they work whether or not
  the panel is on screen — and an agent whose tool list came back empty because
  the operator had not clicked the panel yet would have no way to discover that
  it should ask again. Not on the overlay surface or the recorder bar, which
  are second windows pointed at this same bundle and would race the real one
  for the same channel.
*/
if (surface !== "overlay" && windowKind !== "recorder-bar") registerVideoToolBridge();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {surface === "overlay" ? (
      <AssistantOverlaySurface />
    ) : windowKind === "recorder-bar" ? (
      <RecorderBar />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
