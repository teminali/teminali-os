import { usePanelStore } from "../store/panelStore";
import { addressLabel } from "../utils/address";
import { browserViewBridge } from "./browserView";

/**
 * Put a page in a browser panel, from anywhere in the app.
 *
 * Two steps, and both are needed. The store decides which tab — the one in
 * front, or a new one — and gives it the address as its label. The bridge
 * navigates the view itself, because a view outlives its pane: when the
 * browser tab is not the active one its pane is unmounted, nothing is
 * watching `panel.url`, and a mount deliberately asks for the view as it is
 * rather than reloading it (see BrowserPane). So whoever wants a navigation
 * asks for one here, rather than hoping a pane is there to notice.
 *
 * "The one in front" is the active panel when it is a browser, else the
 * browser tab most recently opened. Every browser tab is its own page with
 * its own history — there can be as many as the operator likes — so this
 * never folds two of them into one.
 */
export function openBrowserAt(url: string, options: { newTab?: boolean } = {}): string {
  const store = usePanelStore.getState();
  const label = addressLabel(url);
  const browsers = store.panels.filter((panel) => panel.kind === "browser");
  const active = browsers.find((panel) => panel.id === store.activePanelId) ?? browsers[browsers.length - 1];
  const id = !options.newTab && active
    ? (store.update(active.id, { url, label }), store.activate(active.id), active.id)
    : store.open({ kind: "browser", url, label });
  browserViewBridge()?.navigate(id, url).catch(() => {});
  return id;
}
