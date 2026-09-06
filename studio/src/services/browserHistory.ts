/**
 * One record of where the browser panel has been.
 *
 * Armed once for the whole app, next to `reapClosedBrowserViews` and
 * `watchBrowserAudio`, and for the same reason all three are global: a view
 * outlives its pane. `BrowserPane` unmounts when the operator merely switches
 * tabs, so a pane that recorded its own navigations would stop recording the
 * page it is still showing the moment another tab took the screen, and would
 * record nothing at all for a tab loading in the background.
 *
 * The gateway owns history (`server/browser-data.js`) because the assistant
 * has to be able to read it, and it folds the repeats: one navigation reports
 * itself as start, stop, and again when the title arrives. This side still
 * dedupes per view, because folding costs a round trip and a navigation storm
 * on a busy page would otherwise be one POST per event.
 *
 * What counts as a visit is in `utils/browserRecording.ts`; this file is the
 * subscription around it.
 */

import type { BrowserViewState } from "./browserView";
import { visitKey, visitOf } from "../utils/browserRecording";
import { useBrowserStore } from "../store/browserStore";

type StateBridge = { onState(handler: (state: BrowserViewState) => void): () => void } | null;

/**
 * Watch every browser view and write what it shows to the gateway.
 *
 * `record` is injected so the subscription can be driven without a gateway;
 * the default is the store's own visit, which posts the row and adopts the one
 * the gateway answers with rather than guessing at it locally.
 */
export function watchBrowserHistory(
  bridge: StateBridge,
  record: (url: string, title: string) => void = (url, title) => {
    void useBrowserStore.getState().visit(url, title);
  },
): () => void {
  if (!bridge) return () => {};
  /** Per view, the last pair actually written. */
  const seen = new Map<string, string>();
  return bridge.onState((state) => {
    if (!state?.id) return;
    if (state.closed) {
      // The view is gone. Forget it, so a later view reusing the id — a tab
      // closed and reopened at the same page — records its first visit.
      seen.delete(state.id);
      return;
    }
    const visit = visitOf(state);
    if (!visit) return;
    const key = visitKey(visit);
    if (seen.get(state.id) === key) return;
    seen.set(state.id, key);
    record(visit.url, visit.title);
  });
}
