/**
 * How a site is identified on the browser's home page, without asking anybody.
 *
 * A list of pages where every row wears the same grey glyph is a list nobody
 * scans — the icon is the only part of a bookmark the eye finds before it
 * reads. The obvious fix is a favicon, and the obvious way to get one is
 * `google.com/s2/favicons?domain=…`, which would mean this application quietly
 * telling Google every site the operator has ever kept. For a local-first app
 * whose whole browser store is on disk precisely so nobody else holds it, that
 * is not a trade worth making for an icon.
 *
 * So the mark is derived: the site's own initial, on a colour hashed from its
 * hostname. Deterministic, offline, and stable — the same site is the same
 * colour in every list, which is what makes it findable at a glance.
 *
 * ## The real icon, from the site itself
 *
 * A shortcut grid is the one place where the derived mark is not enough: a
 * page of coloured letters is a page you read, and the whole point of a
 * shortcut is to be recognised without reading. So a shortcut asks the site
 * for its own `/favicon.ico` and falls back to the derived mark when there
 * isn't one.
 *
 * The distinction that matters is *who is asked*. `favicon.ico` is fetched
 * from the site the operator bookmarked, which already knows they visit it;
 * the favicon service that was refused above is a third party being told the
 * contents of the whole list at once. A site that answers with nothing costs
 * one 404 and shows its letter, which is exactly what it showed before.
 */

/** The registrable-ish part of a host: "docs.github.com" reads as "github". */
export function siteName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 1) return host || "site";
    // Two-part public suffixes ("co.uk", "com.au") would otherwise yield the
    // suffix itself as the name.
    const last = parts[parts.length - 1];
    const penultimate = parts[parts.length - 2];
    if (parts.length >= 3 && penultimate.length <= 3 && last.length <= 3) return parts[parts.length - 3];
    return penultimate;
  } catch {
    return "site";
  }
}

/**
 * Where a site keeps its own icon, or null when the address has no host to ask.
 *
 * The well-known path only. A page can point somewhere else with `<link
 * rel="icon">`, and reading that would mean loading the page to find out —
 * which is a page load per shortcut, for an icon. The letter is the answer for
 * the sites that do.
 */
export function faviconUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** One letter for the tile. Uppercase, and never blank. */
export function siteInitial(url: string): string {
  const name = siteName(url);
  const letter = name.trim()[0];
  return (letter ?? "?").toUpperCase();
}

/**
 * A stable hue for a host, 0–359.
 *
 * A plain sum of character codes collides constantly across short hostnames —
 * "npm" and "mdn" would land within a few degrees of each other. The shift-add
 * below spreads them, and the result only has to be stable and well
 * distributed, not cryptographic.
 */
export function siteHue(url: string): number {
  const name = siteName(url);
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * How long ago, in the two characters a browser has room for.
 *
 * The same vocabulary the sidebar uses for a chat's age, so one list does not
 * say "2d" while another says "2 days ago" about the same span of time.
 */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
