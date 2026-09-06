/**
 * Files the browser panel is fetching.
 *
 * Armed once for the whole app, for the same reason history and audio are: a
 * download outlives the pane that started it, and outlives the tab — the
 * operator clicks a link, switches to the editor, and the file goes on
 * arriving. A pane-owned subscription would lose the progress on the first tab
 * switch and the completed row with it.
 *
 * The division of labour is deliberate. Main chooses nothing: Electron shows
 * its own save dialog, and main only watches what came back so the file can be
 * revealed later. Progress is IPC and stops in `browserStore.active` — a large
 * file updates thousands of times, and a POST per tick would be a store that
 * spent its life being rewritten. Only the end of a download reaches the
 * gateway, where the assistant can read it.
 *
 * What each event means is in `utils/browserRecording.ts`.
 */

import type { BrowserDownload } from "./browserView";
import { downloadAction, type DownloadRecord } from "../utils/browserRecording";
import { useBrowserStore, type ActiveDownload } from "../store/browserStore";

type DownloadBridge = { onDownload(handler: (download: BrowserDownload) => void): () => void } | null;

export interface DownloadSink {
  setActive: (id: string, download: ActiveDownload) => void;
  clearActive: (id: string) => void;
  record: (entry: DownloadRecord) => Promise<void>;
}

const storeSink: DownloadSink = {
  setActive: (id, download) => useBrowserStore.getState().setActive(id, download),
  clearActive: (id) => useBrowserStore.getState().clearActive(id),
  record: (entry) => useBrowserStore.getState().record(entry),
};

export function watchBrowserDownloads(bridge: DownloadBridge, sink: DownloadSink = storeSink): () => void {
  if (!bridge) return () => {};
  return bridge.onDownload((download) => {
    const action = downloadAction(download);
    if (!action) return;
    if (action.kind === "active") {
      sink.setActive(action.id, action.download);
      return;
    }
    if (action.kind === "drop") {
      sink.clearActive(action.id);
      return;
    }
    void sink
      .record(action.entry)
      .catch(() => {
        // A gateway that is restarting loses one row, not the file.
      })
      .finally(() => sink.clearActive(action.id));
  });
}
