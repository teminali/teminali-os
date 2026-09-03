/**
 * What the assistant is allowed to start, and nothing else.
 *
 * The assistant's whole vocabulary was `point | click | type | key | scroll |
 * wait`, which means it could only ever manipulate a control that was already
 * on the screen. Asked to open a browser it answered, correctly and uselessly,
 * that it could not see a browser button anywhere — there was no step in the
 * protocol that starts an application.
 *
 * `launch` is that step, and this file is the reason it is not "run anything".
 * The step names an **id from this catalogue**, not a path, not a command, not
 * an argument vector. An id the model invented resolves to nothing and nothing
 * is started, exactly as an invented element id clicks nothing. That is the
 * same guarantee `PlanStep` makes about coordinates, applied to executables:
 * the dangerous shape is not representable rather than merely discouraged.
 *
 * Two deliberate absences:
 *
 *  - **No terminal.** Terminal, iTerm and friends are a shell prompt, and a
 *    shell prompt plus the `type` step is arbitrary code execution wearing an
 *    allowlist. Anything that would go in this catalogue for the sake of
 *    convenience but hands the assistant a command line stays out of it.
 *  - **No "other" escape hatch.** There is no free-text app field and no
 *    setting that appends to this list, because an allowlist an operator can
 *    be talked into extending mid-session is not an allowlist. Adding an
 *    application is a code change, reviewed like one.
 *
 * A catalogue entry is a claim that an application *may* be started, not that
 * it exists. Whether it is installed is answered on the machine, by
 * `server/assistant.js`, which is also the only place that ever spawns `open`.
 */

export interface LaunchableApp {
  /** What the model writes in `app`. Lowercase, stable, never a path. */
  id: string;
  /** The display name — used for `open -a`, for `say`, and in the HUD. */
  name: string;
  /** What `open -b` is given. Unambiguous where a display name is not. */
  bundleId: string;
  /** True when handing this application a URL is meaningful. */
  browser?: boolean;
  /** Extra words an operator might say for the same application. */
  aliases?: string[];
}

/**
 * The catalogue, ordered the way it is read to the model.
 *
 * Browsers first because "open a browser" is the request this step exists for.
 */
export const LAUNCHABLE_APPS: readonly LaunchableApp[] = Object.freeze([
  { id: "safari", name: "Safari", bundleId: "com.apple.Safari", browser: true, aliases: ["browser", "web browser", "web"] },
  { id: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", browser: true, aliases: ["google chrome"] },
  { id: "edge", name: "Microsoft Edge", bundleId: "com.microsoft.edgemac", browser: true, aliases: ["microsoft edge"] },
  { id: "firefox", name: "Firefox", bundleId: "org.mozilla.firefox", browser: true },
  { id: "arc", name: "Arc", bundleId: "company.thebrowser.Browser", browser: true },
  { id: "brave", name: "Brave Browser", bundleId: "com.brave.Browser", browser: true, aliases: ["brave browser"] },

  { id: "finder", name: "Finder", bundleId: "com.apple.finder" },
  { id: "mail", name: "Mail", bundleId: "com.apple.mail" },
  { id: "calendar", name: "Calendar", bundleId: "com.apple.iCal" },
  { id: "notes", name: "Notes", bundleId: "com.apple.Notes" },
  { id: "reminders", name: "Reminders", bundleId: "com.apple.reminders" },
  { id: "messages", name: "Messages", bundleId: "com.apple.MobileSMS", aliases: ["imessage"] },
  { id: "maps", name: "Maps", bundleId: "com.apple.Maps" },
  { id: "photos", name: "Photos", bundleId: "com.apple.Photos" },
  { id: "preview", name: "Preview", bundleId: "com.apple.Preview" },
  { id: "music", name: "Music", bundleId: "com.apple.Music", aliases: ["apple music"] },
  { id: "spotify", name: "Spotify", bundleId: "com.spotify.client" },
  { id: "appstore", name: "App Store", bundleId: "com.apple.AppStore", aliases: ["app store"] },
  { id: "settings", name: "System Settings", bundleId: "com.apple.systempreferences", aliases: ["system settings", "system preferences"] },

  { id: "vscode", name: "Visual Studio Code", bundleId: "com.microsoft.VSCode", aliases: ["visual studio code", "vs code"] },
  { id: "slack", name: "Slack", bundleId: "com.tinyspeck.slackmacgap" },
  { id: "notion", name: "Notion", bundleId: "notion.id" },
  { id: "zoom", name: "Zoom", bundleId: "us.zoom.xos", aliases: ["zoom.us"] },
]);

const BY_KEY: ReadonlyMap<string, LaunchableApp> = new Map(
  LAUNCHABLE_APPS.flatMap((app) => {
    const keys = [app.id, app.name.toLowerCase(), ...(app.aliases ?? [])];
    return keys.map((key) => [key, app] as const);
  }),
);

/** Longest URL a launch may carry. Real ones are far shorter; this is a bound. */
export const MAX_LAUNCH_URL_LENGTH = 2_000;

/**
 * Resolves what the model wrote to a catalogue entry, or to nothing.
 *
 * Forgiving about spelling — an id, a display name and the words an operator
 * would actually say all resolve — and completely unforgiving about membership.
 */
export function resolveLaunchApp(name: unknown): LaunchableApp | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase().replace(/\.app$/, "").replace(/\s+/g, " ");
  if (!key) return null;
  return BY_KEY.get(key) ?? null;
}

/**
 * Checks a URL a launch would open.
 *
 * `http` and `https` only. Nothing else that `open` understands is a page:
 * `file:` reads the disk, `javascript:` runs in whatever is frontmost, and a
 * custom scheme is a message to another application chosen by the URL rather
 * than by this catalogue. Credentials in the authority are refused too — a
 * model writing `https://user:token@host` would be putting a secret somewhere
 * it gets logged.
 */
export function parseLaunchUrl(value: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || !value.trim()) return { ok: false, reason: "the launch named no address" };
  const text = value.trim();
  if (text.length > MAX_LAUNCH_URL_LENGTH) {
    return { ok: false, reason: `the address exceeds ${MAX_LAUNCH_URL_LENGTH} characters` };
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: `"${text.slice(0, 60)}" is not a web address` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `this assistant only opens http and https addresses, not ${parsed.protocol.replace(":", "")}` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "the address carries credentials" };
  }
  if (!parsed.hostname) return { ok: false, reason: "the address names no host" };
  return { ok: true, url: parsed.toString() };
}

/** The catalogue as one line per application, for the prompt. */
export function launchableInventory(ids?: readonly string[] | null): string {
  const allowed = ids && ids.length > 0 ? new Set(ids) : null;
  const apps = allowed ? LAUNCHABLE_APPS.filter((app) => allowed.has(app.id)) : LAUNCHABLE_APPS;
  return apps
    .map((app) => `  ${app.id} — ${app.name}${app.browser ? " (a browser; may be given a url)" : ""}`)
    .join("\n");
}
