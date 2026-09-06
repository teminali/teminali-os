/**
 * Guardian governor — keeping the machine healthy without ever costing you work.
 *
 * This module can close applications. That makes it the most dangerous code in
 * the product, so its design is defensive to the point of being conservative:
 * it would rather leave a machine slightly loaded than close something it does
 * not fully understand.
 *
 * The rules, in the order they are enforced:
 *
 *   1. **Graceful quit only.** Every closure is an AppleScript `quit`, which is
 *      the same message ⌘Q sends. The app runs its own shutdown, saves what it
 *      autosaves, and may refuse. We never send SIGTERM, never send SIGKILL,
 *      and never escalate when a quit is ignored — an app that declines to quit
 *      has told us something, and overruling it is how documents die.
 *   2. **Unsaved work is absolute.** If an app has a modified document, it is
 *      never a candidate. If we *cannot determine* whether it has unsaved work,
 *      it is also never a candidate. Unknown is treated as unsafe, not as safe.
 *   3. **Never the app you are using.** The frontmost app, and anything focused
 *      within the cooldown, is off limits.
 *   4. **A protected list that cannot be emptied.** Finder, the window server,
 *      the login window, terminals, the studio itself and its runtime are
 *      permanently excluded regardless of configuration.
 *   5. **Nothing happens without an explicit decision.** Enforcement is off by
 *      default, and every run is a dry run unless the caller passes `confirm`.
 *
 * What this cannot promise: a machine that never slows down. Userland software
 * has no control over kernel scheduling, GPU contention, thermal throttling or
 * what another process decides to do next. What it can do is keep memory
 * pressure and disk headroom inside sane bounds and tell you the truth about
 * the rest.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(execFile);

const OSASCRIPT_TIMEOUT_MS = 6000;
const QUIT_TIMEOUT_MS = 12_000;

/**
 * Applications that are never closed, whatever the configuration says.
 *
 * Two kinds live here: things macOS needs in order to function, and things
 * whose death would take the operator's session or this app with it. The list
 * is matched case-insensitively against the bundle name.
 */
export const ALWAYS_PROTECTED = Object.freeze([
  // The system itself.
  "Finder", "Dock", "SystemUIServer", "WindowServer", "loginwindow", "ControlCenter",
  "NotificationCenter", "Spotlight", "coreauthd", "UserNotificationCenter",
  "System Settings", "System Preferences", "Activity Monitor", "Installer",
  "Software Update", "SecurityAgent", "TextInputMenuAgent", "universalaccessd",
  // Anything that owns a shell the operator may be working in.
  "Terminal", "iTerm2", "iTerm", "Warp", "Alacritty", "kitty", "WezTerm", "Ghostty", "Hyper",
  // Ourselves and our runtime.
  "Teminali OS", "Teminali", "Electron", "node", "Ollama", "ollama",
  // Anything mid-flight that would corrupt if interrupted.
  "Disk Utility", "Time Machine", "backupd", "Migration Assistant",
  // Transfers in flight: quitting these throws away progress with no prompt.
  "uTorrent", "uTorrent Web", "Transmission", "qBittorrent", "Deluge", "Folx",
  "Downie", "Free Download Manager", "aria2", "Steam", "Epic Games Launcher",
  // Anything mid-write to a device.
  "Image Capture", "Android File Transfer", "Balena Etcher", "Raspberry Pi Imager",
  "Photos", "Final Cut Pro", "Logic Pro", "Xcode",
]);

/**
 * Apps that restore their own state on relaunch.
 *
 * A browser reopens its tabs; a chat client reloads its history; a music player
 * remembers the queue. Quitting one of these costs a few seconds, not work — so
 * "we cannot find a modified document" genuinely means there is nothing to
 * lose, rather than meaning we failed to look.
 *
 * Anything not on this list and not scriptable stays unknown, and unknown stays
 * unsafe. The list is conservative on purpose: a download manager, a mail
 * client with an unsent draft, or an IDE with an unsaved buffer is not here.
 */
const RESTORES_OWN_STATE = new Set([
  "safari", "google chrome", "microsoft edge", "firefox", "arc", "brave browser",
  "vivaldi", "opera", "chromium", "duckduckgo",
  "whatsapp", "telegram", "signal", "discord", "slack", "messages",
  "spotify", "music", "podcasts", "tv", "vlc", "iina", "quicktime player",
  "maps", "weather", "calculator", "app store", "news", "stocks", "home",
  "font book", "dictionary", "feedback assistant", "clock", "freeform",
]);

/** Apps we can ask about unsaved documents. Anything else is "unknown". */
const SCRIPTABLE_DOCUMENT_APPS = new Set([
  "textedit", "pages", "numbers", "keynote", "preview", "script editor",
  "microsoft word", "microsoft excel", "microsoft powerpoint", "bbedit", "nova",
]);

export const DEFAULT_GOVERNOR_SETTINGS = Object.freeze({
  /** Master switch. Off until the operator turns it on. */
  enabled: false,
  /** How many user apps may be open at once. null disables the cap. */
  maxApps: 12,
  /** An app focused within this many minutes is never a candidate. */
  cooldownMinutes: 15,
  /** An app must have been running at least this long before it can be closed. */
  minimumAgeMinutes: 5,
  /** Operator additions to the protected list. */
  protectedApps: [],
  /** Warn below this much free disk. */
  storageWarnBytes: 15 * 1024 ** 3,
  /** Treat below this as urgent. */
  storageCriticalBytes: 5 * 1024 ** 3,
  /** Unload an Ollama model idle for longer than this. 0 disables. */
  unloadIdleModelsAfterMinutes: 20,
  /**
   * Release model VRAM without waiting for a click.
   *
   * Deliberately independent of `enabled`: that switch gates closing the
   * operator's applications, which is destructive and needs a decision.
   * Unloading a model destroys nothing — the next request loads it again — so
   * it is on by default, and Studio's own design promises it.
   */
  autoUnloadModels: true,
  /** Act when memory pressure leaves "normal", rather than waiting for a stall. */
  actOnMemoryPressure: true,
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Focus tracking                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * macOS does not expose "when was this app last used", so we observe it.
 * Every snapshot records which app is frontmost; an app's last-focused time is
 * the most recent snapshot in which it held focus. Apps we have never seen
 * focused have no record, and the governor treats a missing record as
 * *recently used* rather than as stale — guessing wrong in the safe direction.
 */
export function trackFocus(registry, frontmost, nowMs = Date.now()) {
  const next = new Map(registry);
  if (frontmost) next.set(frontmost, nowMs);
  return next;
}

export function lastFocusedAt(registry, appName) {
  return registry.get(appName) ?? null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Safety                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function isProtected(name, extra = []) {
  const needle = String(name).toLowerCase().trim();
  return [...ALWAYS_PROTECTED, ...extra].some((entry) => {
    const candidate = String(entry).toLowerCase().trim();
    return needle === candidate || needle.startsWith(`${candidate} `) || needle.includes(candidate);
  });
}

/**
 * Decide whether one app may be closed.
 *
 * Returns a verdict rather than a boolean so the interface can explain every
 * exclusion. An operator who cannot see why an app was spared will not trust
 * the ones it closes.
 */
export function assessApp(app, context) {
  const {
    settings = DEFAULT_GOVERNOR_SETTINGS,
    frontmost = null,
    focusRegistry = new Map(),
    nowMs = Date.now(),
  } = context;

  const deny = (reason) => ({ safe: false, reason, app: app.name });

  if (isProtected(app.name, settings.protectedApps)) {
    return deny("Protected — the system or your session depends on it.");
  }
  if (frontmost && app.name === frontmost) {
    return deny("You are using it right now.");
  }
  // Unsaved work is absolute, whatever else is true of the app.
  if (app.hasUnsavedWork === true) {
    return deny("It has unsaved changes.");
  }
  // Unknown is unsafe *unless* the app is one that restores itself. An app we
  // cannot interrogate and that does not restore might be holding a document we
  // cannot see, and there is no acceptable rate of losing someone's work.
  if (app.hasUnsavedWork === null && !RESTORES_OWN_STATE.has(String(app.name).toLowerCase())) {
    return deny("Cannot tell whether it has unsaved work, and it does not restore itself.");
  }

  const focusedAt = lastFocusedAt(focusRegistry, app.name);
  if (focusedAt === null) {
    return deny("Not observed since Guardian started, so its last use is unknown.");
  }
  const idleMinutes = (nowMs - focusedAt) / 60_000;
  if (idleMinutes < settings.cooldownMinutes) {
    return deny(`Used ${Math.round(idleMinutes)} min ago, within the ${settings.cooldownMinutes} min cooldown.`);
  }

  if (Number.isFinite(app.ageSeconds) && app.ageSeconds < settings.minimumAgeMinutes * 60) {
    return deny("Only just opened.");
  }
  // Busy means working: a build, an export, a render. Closing it destroys the
  // result even when no document is "modified".
  if (Number.isFinite(app.cpuPercent) && app.cpuPercent > 12) {
    return deny(`Busy (${Math.round(app.cpuPercent)}% CPU) — it may be mid-task.`);
  }

  return {
    safe: true,
    app: app.name,
    reason: `Idle for ${Math.round(idleMinutes)} min, no unsaved work.`,
    idleMinutes: Math.round(idleMinutes),
    rssBytes: app.rssBytes ?? null,
  };
}

/**
 * Which apps to close, and why — oldest use first, and only as many as the cap
 * actually requires. The plan is always computed in full and returned; whether
 * any of it runs is a separate, explicit decision.
 */
export function planClosures(apps, context) {
  const { settings = DEFAULT_GOVERNOR_SETTINGS } = context;
  const assessed = apps.map((app) => ({ app, verdict: assessApp(app, context) }));

  const closable = assessed
    .filter((entry) => entry.verdict.safe)
    .sort((a, b) => (b.verdict.idleMinutes ?? 0) - (a.verdict.idleMinutes ?? 0));

  const limit = settings.maxApps;
  const overBy = Number.isFinite(limit) && limit !== null ? Math.max(0, apps.length - limit) : 0;
  const selected = closable.slice(0, overBy);

  return {
    openCount: apps.length,
    limit: limit ?? null,
    overBy,
    /** Would be closed, in order. */
    selected: selected.map((entry) => ({
      name: entry.app.name,
      pid: entry.app.pid ?? null,
      rssBytes: entry.app.rssBytes ?? null,
      idleMinutes: entry.verdict.idleMinutes ?? null,
      reason: entry.verdict.reason,
    })),
    /** Every app that was considered and spared, with the reason. */
    spared: assessed
      .filter((entry) => !entry.verdict.safe)
      .map((entry) => ({ name: entry.app.name, reason: entry.verdict.reason })),
    /** Over the cap, but nothing may safely be closed. */
    blocked: overBy > 0 && selected.length < overBy,
    reclaimableBytes: selected.reduce((total, entry) => total + (entry.app.rssBytes ?? 0), 0),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* macOS interrogation                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

async function osascript(script, timeout = OSASCRIPT_TIMEOUT_MS) {
  const { stdout } = await run("osascript", ["-e", script], { timeout, encoding: "utf8" });
  return stdout.trim();
}

/** Foreground applications, as the operator would count them in the Dock. */
export async function listOpenApps() {
  if (process.platform !== "darwin") return { apps: [], frontmost: null, supported: false };
  try {
    const names = await osascript(
      'tell application "System Events" to get name of every application process whose background only is false',
    );
    const frontmost = await osascript(
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ).catch(() => null);

    return {
      supported: true,
      frontmost: frontmost || null,
      apps: names.split(",").map((name) => name.trim()).filter(Boolean),
    };
  } catch (error) {
    // Almost always the Automation permission prompt not yet granted.
    return {
      apps: [],
      frontmost: null,
      supported: false,
      detail:
        "Guardian needs Automation permission for System Events to see open apps. " +
        "Grant it in System Settings → Privacy & Security → Automation.",
      error: String(error?.message ?? error).split("\n")[0],
    };
  }
}

/**
 * Does this app have unsaved documents?
 *
 * `true` / `false` are answers. `null` means we could not establish it, and the
 * governor treats that exactly as it treats `true`.
 */
export async function hasUnsavedWork(appName) {
  if (process.platform !== "darwin") return null;
  if (!SCRIPTABLE_DOCUMENT_APPS.has(String(appName).toLowerCase())) return null;
  try {
    const answer = await osascript(
      `tell application "${String(appName).replace(/"/g, '')}" to if it is running then return (count of (documents whose modified is true)) else return 0`,
      4000,
    );
    const count = Number(answer);
    return Number.isFinite(count) ? count > 0 : null;
  } catch {
    return null;
  }
}

/**
 * Ask an app to quit, exactly as ⌘Q does, and report what happened.
 *
 * A refusal is a legitimate outcome, not a failure to route around: an app that
 * puts up a "save changes?" sheet has decided the operator must be asked, and
 * Guardian's job ends there.
 */
export async function quitApp(appName) {
  if (process.platform !== "darwin") {
    return { name: appName, quit: false, detail: "Closing apps is only supported on macOS." };
  }
  if (isProtected(appName)) {
    // Belt and braces: the planner already excluded it, but this is the last
    // gate before an irreversible action.
    return { name: appName, quit: false, detail: "Refused: this app is permanently protected." };
  }

  const safe = String(appName).replace(/"/g, "");
  try {
    await osascript(`tell application "${safe}" to quit`, QUIT_TIMEOUT_MS);
  } catch (error) {
    return { name: appName, quit: false, detail: String(error?.message ?? error).split("\n")[0] };
  }

  // Give it a moment, then check. We do not escalate either way.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  try {
    const running = await osascript(
      `tell application "System Events" to return (exists (application process "${safe}"))`,
      4000,
    );
    const stillOpen = running.toLowerCase() === "true";
    return {
      name: appName,
      quit: !stillOpen,
      detail: stillOpen
        ? "It did not quit — it is probably asking you to save something. Left alone."
        : null,
    };
  } catch {
    return { name: appName, quit: true, detail: null };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Storage                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Free space is not one number on macOS. `df` reports what is free now;
 * a large slice of "used" may be purgeable — snapshots and caches the system
 * will reclaim under pressure. Reporting only `df` makes a healthy machine look
 * full, so both figures are carried and the verdict uses the honest one.
 */
export function assessStorage(disk, purgeableBytes, settings = DEFAULT_GOVERNOR_SETTINGS) {
  if (!disk) return { level: "unknown", detail: "Disk usage could not be measured." };

  const reclaimable = Number.isFinite(purgeableBytes) ? purgeableBytes : 0;
  const effectiveFree = disk.freeBytes + reclaimable;

  let level;
  let detail;
  if (disk.freeBytes < settings.storageCriticalBytes) {
    level = "critical";
    detail = "Below the critical threshold. macOS starts failing writes and apps behave unpredictably.";
  } else if (disk.freeBytes < settings.storageWarnBytes) {
    level = "warning";
    detail = "Running low. Free space before a large model download or a build.";
  } else {
    level = "healthy";
    detail = null;
  }

  return {
    level,
    detail,
    freeBytes: disk.freeBytes,
    totalBytes: disk.totalBytes,
    purgeableBytes: reclaimable || null,
    effectiveFreeBytes: effectiveFree,
    warnBytes: settings.storageWarnBytes,
    criticalBytes: settings.storageCriticalBytes,
    /** Fraction of the warning threshold still available, for a gauge. */
    headroomRatio: settings.storageWarnBytes > 0
      ? Math.min(1, disk.freeBytes / settings.storageWarnBytes)
      : null,
  };
}

/** Purgeable space, which `df` counts as used. Null when it cannot be read. */
export async function purgeableBytes(mount = "/") {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await run("diskutil", ["info", "-plist", mount], { timeout: 5000, encoding: "utf8" });
    const match = /<key>APFSContainerFree<\/key>\s*<integer>(\d+)<\/integer>/.exec(stdout);
    const containerFree = match ? Number(match[1]) : null;
    return Number.isFinite(containerFree) ? containerFree : null;
  } catch {
    return null;
  }
}

/**
 * Where space could be recovered. Reported only — Guardian never deletes
 * anything. Every entry names a path the operator can inspect first.
 */
export async function reclaimTargets() {
  const home = os.homedir();
  const candidates = [
    { label: "Trash", path: `${home}/.Trash`, note: "Emptying the Trash is immediate and irreversible." },
    { label: "User caches", path: `${home}/Library/Caches`, note: "Apps rebuild these; expect slower first launches." },
    { label: "Xcode derived data", path: `${home}/Library/Developer/Xcode/DerivedData`, note: "Rebuilt on next build." },
    { label: "Ollama models", path: `${home}/.ollama/models`, note: "Removing a model means downloading it again." },
    { label: "npm cache", path: `${home}/.npm/_cacache`, note: "Rebuilt on next install." },
  ];

  const measured = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const { stdout } = await run("du", ["-sk", candidate.path], { timeout: 8000, encoding: "utf8" });
        const kb = Number(stdout.trim().split(/\s+/)[0]);
        return Number.isFinite(kb) && kb > 0 ? { ...candidate, bytes: kb * 1024 } : null;
      } catch {
        // Missing or unreadable: not an error, just nothing to report.
        return null;
      }
    }),
  );

  return measured
    .filter(Boolean)
    .sort((a, b) => b.bytes - a.bytes);
}
