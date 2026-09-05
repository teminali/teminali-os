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
 * The step names an **id**, not a path, not a command, not an argument vector.
 * An id the model invented resolves to nothing and nothing is started, exactly
 * as an invented element id clicks nothing. That is the same guarantee
 * `PlanStep` makes about coordinates, applied to executables: the dangerous
 * shape is not representable rather than merely discouraged.
 *
 * **Where the ids come from changed.** They were this file and only this file —
 * an allowlist of two dozen applications, and asking for anything else got a
 * refusal. The operator's answer to that was direct: let it open anything they
 * actually have. So the list is now assembled on the machine, by
 * `server/assistant.js`, from what is on disk: this catalogue first, then every
 * other `.app` under `/Applications`, `~/Applications` and
 * `/System/Applications`. It arrives on the observation and the model is read
 * the result.
 *
 * What survives the widening, and why:
 *
 *  - **Still no terminal.** Terminal, iTerm and friends are a shell prompt, and
 *    a shell prompt plus the `type` step is arbitrary code execution wearing an
 *    allowlist. The scan skips them by name, along with Script Editor and
 *    Automator, which run `do shell script` from a document. "Any application"
 *    that included a command line would make the CLI permission gate
 *    ornamental — everything it guards would be reachable by typing into a
 *    window instead.
 *  - **Still no free-text field.** There is no setting that appends to what the
 *    model may name. The list widened because the *filesystem* says so, not
 *    because anything can be talked into extending it mid-session.
 *  - **Still never a path.** The step names an id; the path lives on the
 *    gateway, which is the only place that ever spawns `open`.
 *
 * This file keeps the curated entries because they carry what a scan cannot
 * infer: a stable spoken id, the words an operator would actually say, and the
 * `browser` flag that decides whether a URL may be handed over. A curated entry
 * always wins the name it claims.
 */

export interface LaunchableApp {
  /** What the model writes in `app`. Lowercase, stable, never a path. */
  id: string;
  /** The display name — used for `open -a`, for `say`, and in the HUD. */
  name: string;
  /**
   * What `open -b` is given. Unambiguous where a display name is not.
   *
   * Absent on an application the gateway found by scanning `/Applications`:
   * nothing read its plist, because `open -a <path>` never needed one.
   */
  bundleId?: string;
  /** True when handing this application a URL is meaningful. */
  browser?: boolean;
  /** Extra words an operator might say for the same application. */
  aliases?: string[];
}

/**
 * One application the gateway reported as installed.
 *
 * The wire shape of `observation.launchable`. Smaller than a catalogue entry on
 * purpose — the path stays on the gateway side, where it is the thing a caller
 * must not be able to choose.
 */
export interface LaunchableEntry {
  id: string;
  name: string;
  browser?: boolean;
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

/** The observation's list, whatever shape it arrived in, as entries. */
function entries(available?: readonly (string | LaunchableEntry)[] | null): LaunchableEntry[] {
  if (!available) return [];
  return available.map((item) => {
    if (typeof item !== "string") return item;
    // A bare id, from an observation taken before the list carried names.
    const curated = BY_KEY.get(item);
    return curated ? { id: curated.id, name: curated.name, browser: curated.browser } : { id: item, name: item };
  });
}

/** The ids in an observation's list, for a membership check. */
export function launchableIds(available?: readonly (string | LaunchableEntry)[] | null): Set<string> {
  return new Set(entries(available).map((entry) => entry.id));
}

/**
 * Resolves what the model wrote to an application, or to nothing.
 *
 * Forgiving about spelling — an id, a display name and the words an operator
 * would actually say all resolve — and completely unforgiving about membership.
 *
 * Membership is now two things rather than one. The curated catalogue is the
 * part that is written down here: it carries the aliases, the spoken ids and
 * the `browser` flag, and it resolves whether or not the machine was asked.
 * `available` is the rest — every other application the gateway found on this
 * operator's disk — and it resolves by id or by exact display name, because a
 * discovered application has no aliases for the same reason it has no bundle
 * id: nobody wrote it down, it was simply there.
 *
 * What has *not* widened is the shape. The step still names something from a
 * list this machine produced. An id the model invented resolves to nothing.
 */
export function resolveLaunchApp(
  name: unknown,
  available?: readonly (string | LaunchableEntry)[] | null,
): LaunchableApp | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase().replace(/\.app$/, "").replace(/\s+/g, " ");
  if (!key) return null;
  const curated = BY_KEY.get(key);
  if (curated) return curated;
  for (const entry of entries(available)) {
    if (entry.id === key || entry.name.toLowerCase() === key) return entry;
  }
  return null;
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

/**
 * Most applications named in the prompt.
 *
 * The gateway will happily report two hundred; reading all of them to the model
 * on every observation is a thousand tokens a turn to list bundles nobody is
 * going to ask for. The list is ordered so the ceiling falls on the tail — the
 * curated entries and the browsers are always in it — and the model is told the
 * remainder exists and can be named outright.
 */
export const MAX_INVENTORY_APPS = 120;

/** What this machine can open, one line per application, for the prompt. */
export function launchableInventory(available?: readonly (string | LaunchableEntry)[] | null): string {
  const apps = available && available.length > 0 ? entries(available) : LAUNCHABLE_APPS;
  const shown = apps.slice(0, MAX_INVENTORY_APPS);
  const lines = shown.map(
    (app) => `  ${app.id} — ${app.name}${app.browser ? " (a browser; may be given a url)" : ""}`,
  );
  const hidden = apps.length - shown.length;
  if (hidden > 0) {
    lines.push(`  …and ${hidden} more installed applications — name one exactly as it appears in its menu bar.`);
  }
  return lines.join("\n");
}
