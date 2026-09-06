import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { AssistantOverlaySurface } from "./components/assistant/AssistantOverlaySurface";
import { RecorderBar } from "./components/recorder/RecorderBar";
import { useStudioStore } from "./store/studioStore";
import { registerVideoToolBridge } from "./services/videoToolBridge";
import { installWindowDropGuard } from "./services/dropGuard";
import { syncWorkspaceMediaRoot } from "./services/workspaceMedia";
import { browserViewBridge, reapClosedBrowserViews } from "./services/browserView";
import { watchBrowserHistory } from "./services/browserHistory";
import { watchBrowserDownloads } from "./services/browserDownloads";
import { selfAudio, watchBrowserAudio, watchMediaElements } from "./services/voice/selfAudio";
import { usePanelStore } from "./store/panelStore";

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
  A file dropped anywhere but a real drop zone must not navigate the window.

  Armed here rather than in a component, and before the first render, because
  the thing it protects is the document itself: Chromium's default for an
  unclaimed drop is to load the file, which in Electron replaces the whole
  application with a text file and looks exactly like a crash to a blank page.
  It applies to all three surfaces this bundle serves — the overlay and the
  recorder bar have no drop zones at all, so for them it is the only handler.
  See services/dropGuard.ts for how it stays out of the way of the composer,
  the media panel, the timeline and the file pane.
*/
installWindowDropGuard();

/*
  Which project the media protocol should serve from, for a development build.
  A packaged app answers that from the gateway it runs itself and ignores this;
  main also ignores any window but the real one. See services/workspaceMedia.ts.
*/
syncWorkspaceMediaRoot(useStudioStore);

/*
  The browser panel's pages are views layered over this window, not frames in
  this document, so closing a tab has to end one — and the pane cannot tell
  that from the operator merely switching tabs, since both unmount it. Only the
  store knows, so the reaping is a subscription. See services/browserView.ts.
*/
reapClosedBrowserViews(usePanelStore);

/*
  Where the browser has been, recorded once for the whole app.

  Same reason the reaping is here: a view outlives its pane, so a tab loading
  in the background is unmounted and still navigating. The gateway owns the
  list because the assistant has to be able to read it.
  See services/browserHistory.ts.
*/
watchBrowserHistory(browserViewBridge());

/*
  Files the browser is fetching, watched for the same reason: a download
  outlives the tab that started it. Progress stops in the renderer's cache;
  only the end of one is written to the gateway.
  See services/browserDownloads.ts.
*/
watchBrowserDownloads(browserViewBridge());

/*
  The app has to know when it is the one making noise.

  The Files panel plays video and audio and the Browser panel loads pages that
  do, and all of it reaches the microphone, where it is indistinguishable from
  an operator — it is real speech, correctly transcribed. Both watches are
  armed here rather than by the panes because a source outlives its pane: a
  browser tab in the background is unmounted and still audible.
  See services/voice/selfAudio.ts.
*/
watchMediaElements(selfAudio);
watchBrowserAudio(selfAudio, browserViewBridge());

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
