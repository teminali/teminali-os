import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { AssistantOverlaySurface } from "./components/assistant/AssistantOverlaySurface";
import { useStudioStore } from "./store/studioStore";

/**
 * Which surface this document is.
 *
 * Electron mounts the assistant's drawing layer in its own transparent window
 * pointed at this same bundle with `?surface=overlay`. Branching here rather
 * than shipping a second HTML file is what lets that layer be ordinary React
 * against the ordinary token sheet — a hand-written overlay page would have
 * needed its own copy of every colour, and a copy of the token sheet drifts.
 */
const surface = new URLSearchParams(window.location.search).get("surface");

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {surface === "overlay" ? <AssistantOverlaySurface /> : <App />}
  </React.StrictMode>
);
