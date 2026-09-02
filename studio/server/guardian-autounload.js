/**
 * Automatic VRAM release for resident Ollama models.
 *
 * Guardian's advice layer observes and never mutates: it renders "this model is
 * idle, unloading frees 15 GB" and waits for a click. That is the right posture
 * for closing someone's applications. It is the wrong posture for a model the
 * operator has already stopped talking to, because the cost of waiting is paid
 * continuously — on a 24 GB machine a 15 GB model left wired is the difference
 * between a responsive Mac and one that swaps on every keystroke.
 *
 * So this module acts, under rules narrow enough that acting is uncontroversial:
 * unloading is reversible (the next request reloads the model), it destroys no
 * work, and every eviction is decided from measurements rather than guesses.
 *
 * Two rules, both drawn from failures Guardian already documents:
 *
 *   idle       — nobody has touched the model for longer than the configured
 *                threshold. This is the setting `unloadIdleModelsAfterMinutes`,
 *                which until now was persisted, clamped, and never read.
 *
 *   superseded — more than one model is resident. buildAdvice already calls this
 *                "nearly always accidental": switching models mid-session leaves
 *                the previous one wired for the remainder of its keep-alive.
 *                The most recently used model stays; the rest go.
 *
 * The planner is pure so the rules can be tested without a machine, an Ollama,
 * or a clock. The sweep is the only part that touches anything.
 */

import { guardianSnapshot, unloadModel } from "./guardian.js";
import { DEFAULT_GOVERNOR_SETTINGS } from "./guardian-governor.js";

/** How often the sweep looks. Cheap enough to be frequent, slow enough to be quiet. */
export const AUTO_UNLOAD_INTERVAL_MS = 45_000;

/**
 * Never evict a model that has been untouched for less than this, whatever the
 * settings say. A threshold of a few seconds would fight the user's own typing
 * pauses, and `unloadIdleModelsAfterMinutes` is operator-editable.
 */
export const IDLE_FLOOR_SECONDS = 60;

/**
 * A superseded model gets this long before it is evicted. Model switches often
 * come in pairs — a mis-click and a correction — and evicting on the first of
 * them would make the second one pay a full reload.
 */
export const SUPERSEDED_GRACE_SECONDS = 30;

/**
 * Decide which resident models to unload.
 *
 * Returns both the evictions and the sparings, each carrying the measurement it
 * was drawn from. Guardian's existing advice layer explains every exclusion for
 * the same reason: a governor whose sparings are invisible is one you cannot
 * tell from a broken governor.
 *
 * @param {Array<object>} models  Resident models, as `trackResidency` shapes them.
 * @param {object} settings       Sanitised governor settings.
 * @returns {{ unload: Array<object>, spared: Array<object> }}
 */
export function planAutoUnload(models, settings = DEFAULT_GOVERNOR_SETTINGS) {
  const resident = Array.isArray(models) ? models.filter((model) => model?.name) : [];
  const unload = [];
  const spared = [];

  if (settings?.autoUnloadModels === false) {
    for (const model of resident) spared.push({ name: model.name, reason: "Automatic unloading is switched off." });
    return { unload, spared };
  }

  /* Ollama pushes `expires_at` forward while a request is in flight, and holds
     the model past its own deadline until that request finishes — which is what
     a negative `expiresInSeconds` means. Evicting there would kill a response
     mid-stream, so in-flight beats every other rule below. */
  const inFlight = (model) => Number.isFinite(model.expiresInSeconds) && model.expiresInSeconds < 0;

  /* "Most recently used" is the model whose expiry sits furthest out: every
     request pushes it forward, so the largest expiry is the last one touched.
     Models with no expiry at all cannot be compared this way and are never
     treated as superseded — unknown resolves in favour of keeping. */
  const comparable = resident.filter((model) => Number.isFinite(model.expiresAtMs));
  const newest = comparable.reduce(
    (best, model) => (best === null || model.expiresAtMs > best.expiresAtMs ? model : best),
    null,
  );

  const idleThresholdSeconds = Math.max(
    IDLE_FLOOR_SECONDS,
    Number(settings?.unloadIdleModelsAfterMinutes ?? DEFAULT_GOVERNOR_SETTINGS.unloadIdleModelsAfterMinutes) * 60,
  );
  const idleRuleOn = Number(settings?.unloadIdleModelsAfterMinutes ?? 0) > 0;

  for (const model of resident) {
    if (inFlight(model)) {
      spared.push({ name: model.name, reason: "A request is still in flight." });
      continue;
    }

    const superseded =
      resident.length > 1 &&
      newest !== null &&
      model.name !== newest.name &&
      Number.isFinite(model.expiresAtMs) &&
      model.idleSeconds >= SUPERSEDED_GRACE_SECONDS;

    if (superseded) {
      unload.push({
        name: model.name,
        rule: "superseded",
        vramBytes: model.vramBytes ?? null,
        detail: `${newest.name} is now the active model; this one is still wired.`,
        evidence: [
          `idle ${model.idleSeconds}s`,
          `${resident.length} models resident at once`,
        ],
      });
      continue;
    }

    if (idleRuleOn && model.idleSeconds >= idleThresholdSeconds) {
      unload.push({
        name: model.name,
        rule: "idle",
        vramBytes: model.vramBytes ?? null,
        detail: `Untouched for longer than the ${Math.round(idleThresholdSeconds / 60)} minute threshold.`,
        evidence: [
          `idle ${model.idleSeconds}s${model.idleIsLowerBound ? " or more" : ""}`,
          `threshold ${idleThresholdSeconds}s`,
        ],
      });
      continue;
    }

    spared.push({
      name: model.name,
      reason: idleRuleOn
        ? `Idle ${model.idleSeconds}s, under the ${idleThresholdSeconds}s threshold.`
        : "The idle rule is switched off.",
    });
  }

  return { unload, spared };
}

/**
 * The acting half: look, plan, evict.
 *
 * Every dependency is injected so the sweep can be driven in a test without a
 * timer, an Ollama, or a real machine underneath it.
 */
export function createAutoUnloadSweep({
  readSettings,
  snapshot = guardianSnapshot,
  unload = unloadModel,
  onEvent = () => {},
  intervalMs = AUTO_UNLOAD_INTERVAL_MS,
} = {}) {
  if (typeof readSettings !== "function") {
    throw new TypeError("readSettings must be a function");
  }

  let timer = null;
  let running = false;

  async function runOnce() {
    /* Overlapping sweeps would double-count: the second one reads residency
       before the first one's evictions have landed and plans against a machine
       state that is already stale. */
    if (running) return { skipped: "in-progress", unloaded: [], failed: [] };
    running = true;
    try {
      const settings = readSettings();
      if (settings?.autoUnloadModels === false) return { skipped: "disabled", unloaded: [], failed: [] };

      const machine = await snapshot({ processLimit: 1 });
      const resident = machine?.ollama?.residentModels ?? [];
      if (resident.length === 0) return { skipped: "none-resident", unloaded: [], failed: [] };

      const plan = planAutoUnload(resident, settings);
      const unloaded = [];
      const failed = [];

      for (const target of plan.unload) {
        try {
          const result = await unload(target.name);
          unloaded.push({ ...target, freedBytes: result?.freedBytes ?? target.vramBytes ?? null });
          await onEvent({
            event: "guardian-auto-unloaded",
            model: target.name,
            rule: target.rule,
            vramBytes: target.vramBytes,
            evidence: target.evidence,
          });
        } catch (error) {
          /* A model that vanished between the plan and the call is the sweep
             working, not failing — something else already freed it. */
          const code = error?.code ?? null;
          if (code !== "MODEL_NOT_RESIDENT") {
            failed.push({ name: target.name, code, message: error?.message ?? "unknown error" });
            await onEvent({ event: "guardian-auto-unload-failed", model: target.name, errorCode: code });
          }
        }
      }

      return { skipped: null, unloaded, failed, spared: plan.spared };
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => void runOnce().catch(() => {}), intervalMs);
      // The sweep must never be the reason the process stays alive.
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    get active() {
      return timer !== null;
    },
  };
}
