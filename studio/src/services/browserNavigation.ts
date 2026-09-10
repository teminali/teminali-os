import { usePanelStore } from "../store/panelStore";
import { addressLabel } from "../utils/address";
import { browserViewBridge } from "./browserView";

/**
 * The browser tab "in front", or null when none is open.
 *
 * The active panel when it is a browser, else the browser tab most recently
 * opened. Every browser tab is its own page with its own history — there can
 * be as many as the operator likes — so this never folds two of them into one.
 *
 * Private tabs are never the one in front. Whatever asked for a page — an
 * artifact preview, the agent, a link from a chat — did not ask for it to be
 * private, and dropping it into a private tab would put it on the wrong
 * session and hide it from the history the assistant reads back.
 *
 * Exported because the agent reads a page through `services/browserAgent.ts`
 * and navigates it through `openBrowserAt` below, and those two must be
 * talking about the same tab. When they were two copies of this rule, `browse`
 * opening one panel and `page_snapshot` reading another was a change away.
 */
export function targetBrowserPanelId(): string | null {
  const store = usePanelStore.getState();
  const browsers = store.panels.filter((panel) => panel.kind === "browser" && !panel.private);
  const active = browsers.find((panel) => panel.id === store.activePanelId) ?? browsers[browsers.length - 1];
  return active?.id ?? null;
}

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
 */
export function openBrowserAt(url: string, options: { newTab?: boolean } = {}): string {
  const store = usePanelStore.getState();
  const label = addressLabel(url);
  const target = options.newTab ? null : targetBrowserPanelId();
  const id = target
    ? (store.update(target, { url, label }), store.activate(target), target)
    : store.open({ kind: "browser", url, label });
  browserViewBridge()?.navigate(id, url).catch(() => {});
  return id;
}
