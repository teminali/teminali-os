/**
 * Guardian's persisted settings and its in-memory focus history.
 *
 * The focus registry deliberately does not persist. It records which apps were
 * observed in use, and that observation is only meaningful for the current
 * session: an app last focused before a reboot is not "idle for three days",
 * it is unknown. Starting empty each run means the governor has to earn its
 * knowledge before it can act on it, which is the conservative default.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_GOVERNOR_SETTINGS } from "./guardian-governor.js";

let focusRegistry = new Map();

export function getFocusRegistry() {
  return focusRegistry;
}

export function setFocusRegistry(registry) {
  focusRegistry = registry;
}

export function readGovernorSettings(storePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return sanitise({ ...DEFAULT_GOVERNOR_SETTINGS, ...parsed });
  } catch {
    return { ...DEFAULT_GOVERNOR_SETTINGS };
  }
}

export function writeGovernorSettings(storePath, settings) {
  const clean = sanitise({ ...DEFAULT_GOVERNOR_SETTINGS, ...settings });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temporary = `${storePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(clean, null, 2));
  fs.renameSync(temporary, storePath);
  return clean;
}

/**
 * Clamp everything to a range that cannot hurt the machine.
 *
 * A cap of 1 would close every app the moment a second one opened; a zero
 * cooldown would close something you used a second ago. These bounds are not
 * suggestions the caller may exceed — they are the reason the feature is safe
 * to hand to a settings panel at all.
 */
export function sanitise(settings) {
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  const GB = 1024 ** 3;
  const critical = number(settings.storageCriticalBytes, DEFAULT_GOVERNOR_SETTINGS.storageCriticalBytes, 2 * GB, 200 * GB);
  // The warning must sit above the critical line or neither means anything.
  const warn = Math.max(
    critical + GB,
    number(settings.storageWarnBytes, DEFAULT_GOVERNOR_SETTINGS.storageWarnBytes, 3 * GB, 500 * GB),
  );

  return {
    enabled: settings.enabled === true,
    maxApps: settings.maxApps === null ? null : number(settings.maxApps, DEFAULT_GOVERNOR_SETTINGS.maxApps, 3, 60),
    cooldownMinutes: number(settings.cooldownMinutes, DEFAULT_GOVERNOR_SETTINGS.cooldownMinutes, 5, 240),
    minimumAgeMinutes: number(settings.minimumAgeMinutes, DEFAULT_GOVERNOR_SETTINGS.minimumAgeMinutes, 1, 120),
    protectedApps: Array.isArray(settings.protectedApps)
      ? settings.protectedApps.filter((name) => typeof name === "string" && name.trim()).slice(0, 100).map((n) => n.trim())
      : [],
    storageWarnBytes: warn,
    storageCriticalBytes: critical,
    unloadIdleModelsAfterMinutes: number(settings.unloadIdleModelsAfterMinutes, DEFAULT_GOVERNOR_SETTINGS.unloadIdleModelsAfterMinutes, 0, 720),
    autoUnloadModels: settings.autoUnloadModels !== false,
    actOnMemoryPressure: settings.actOnMemoryPressure !== false,
  };
}
