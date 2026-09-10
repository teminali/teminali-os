/**
 * Where a link clicked inside the app opens.
 *
 * Chat answers are full of links, and until now every one of them carried
 * `target="_blank"` and left for the system browser. That is a reasonable
 * default for a web page and a poor one for this app, because the app *has* a
 * browser: `openBrowserAt` puts the page in a panel beside the conversation
 * that produced it, which is where you want a doc page you are about to quote
 * back at the agent.
 *
 * So it becomes a preference rather than a hard-coded choice, and this is the
 * single function every clickable link in the app goes through. It is not a
 * React hook on purpose — the markdown renderer's inline pass is a pure
 * function over tokens with no store and no context, and threading a hook into
 * it to answer a yes/no question would be the more invasive change.
 *
 * The plan called this row "PR Link Destination", after Cursor's. Ours governs
 * every link, because we have no PR flow for it to be narrower than — see
 * `docs/SETTINGS_AND_CHROME_PLAN.md` §3.
 */

import { currentPreferences } from "./preferences.ts";
import { browserViewBridge } from "./browserView.ts";

/**
 * Only these leave the app. `openExternal` will hand a `file:` or a
 * `javascript:` URL to the OS as willingly as an `https:` one, and a link in a
 * chat answer is text a model produced — the safest place to say no is here,
 * at the one door, rather than at each caller.
 */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Whether this URL is one we will open at all, and how it parses. */
export const parseLink = (href: string): URL | null => {
  try {
    const url = new URL(href, typeof window === "undefined" ? undefined : window.location.href);
    return EXTERNAL_SCHEMES.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
};

/**
 * Open a link the way the operator asked for.
 *
 * `mailto:` always leaves, whatever the preference says: the in-app browser is
 * a web view, and handing it a mail URL shows an error page instead of a
 * compose window.
 */
export const openLink = (href: string): void => {
  const url = parseLink(href);
  if (!url) return;

  const bridge = browserViewBridge();
  const external = () => {
    if (bridge) void bridge.openExternal(url.href);
    else if (typeof window !== "undefined") window.open(url.href, "_blank", "noopener,noreferrer");
  };

  if (url.protocol === "mailto:" || currentPreferences().linkDestination === "system") {
    external();
    return;
  }

  /* Lazily imported: this module is reachable from the markdown renderer,
     which the tests load without a panel store behind it. */
  void import("./browserNavigation.ts")
    .then(({ openBrowserAt }) => openBrowserAt(url.href))
    .catch(external);
};
