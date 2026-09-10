/**
 * What the plans are, and what each one unlocks.
 *
 * This file is the single authority on that question. The billing service
 * reads it to decide what to sign into a licence; the app reads its own copy
 * of the capability NAMES to decide what to gate. Nothing else in either half
 * is allowed to hold an opinion about which plan can do what — a gate that
 * tests `plan === "pro"` somewhere in a component is exactly how a product
 * ends up unable to launch a trial, a lifetime tier, or a regional price
 * without touching twenty files.
 *
 * ## The shape of the decision
 *
 * Gates are on CAPABILITIES, never on plan names. A capability is a thing the
 * product can do; a plan is a bundle of them that someone paid for. Renaming
 * "Pro" to "Studio" must not change behaviour, and adding "Team" must not
 * require editing a single gate.
 *
 * ## What is gated today, and why only this
 *
 * Pro carries `frontier.escalation` and `voice.vibevoice`. Two capabilities,
 * gated for two different reasons, and the difference is worth stating because
 * it decides how each one behaves when a user does not have it:
 *
 *   - **`frontier.escalation` costs money per turn.** The Auto lane's Claude
 *     Sonnet escalation and the `claude-sonnet` / `claude-opus` profiles bill
 *     against `ANTHROPIC_API_KEY` on every call. Subscription revenue offsets
 *     an actual unit cost. A free user asking for it is REFUSED — 402, with an
 *     upgrade path — because there is no cheaper way to answer the request.
 *   - **`voice.vibevoice` was a quality tier, and is now granted to FREE**
 *     (2026-09-05). The argument for gating it was that a free user still had
 *     working speech — whisper.cpp and the system voices — so the gate priced
 *     the feature rather than any compute, since the sidecar runs on the
 *     user's own machine. That argument held only on macOS. On Windows
 *     `speech-local.js` returns unavailable, there is no `say`, and
 *     `webSpeech.ts#probe` disables the Chromium recogniser inside Electron:
 *     the "cheaper answer" does not exist and a free Windows user had no voice
 *     at all. Gating it there contradicted the principle in the paragraph
 *     below — the offline half of the product must not be the half that stops
 *     working. The capability is still registered rather than deleted, so
 *     licences already signed with it stay valid and re-gating stays possible.
 *
 * `frontier.max` is registered but granted to FREE, and that is also economic:
 * the Qwen3.8 27B expert burns the user's own electricity. Gating it would
 * charge rent on hardware they already own, and it would mean the offline half
 * of the product — the half that most needs to work on a plane — is the half
 * that stops working when a card expires.
 */

/**
 * Every capability the product knows how to gate.
 *
 * `label` and `description` are user-facing: they appear on the upgrade screen
 * and in the entitlement panel, so they are written for a person deciding
 * whether to pay, not for a developer reading a config.
 */
export const CAPABILITIES = Object.freeze({
  "frontier.escalation": {
    label: "Hosted escalation",
    description:
      "Frontier Auto's escalation to Claude Sonnet, plus the Claude Sonnet and Opus profiles. These call a hosted model and cost money per turn.",
  },
  "frontier.max": {
    label: "Frontier Max",
    description: "The flagship online Gemini tier via Claude Code for advanced reasoning, online search, and multi-file code editing.",
  },
  "voice.vibevoice": {
    label: "Local speech sidecar",
    description:
      "Recognition and synthesis from a sidecar on your own machine, in place of the built-in Web Speech voices. Granted to every plan; the key is kept for licences already signed with it.",
  },
});

/**
 * The plans, and the capabilities each one carries.
 *
 * `free` is not the absence of a plan — it is a plan with a capability list,
 * and an app with no licence at all resolves to exactly this. Writing it out
 * means "what can a signed-out user do" has one answer in one place, rather
 * than being the accidental sum of every gate that happens to fail closed.
 */
export const PLANS = Object.freeze({
  free: Object.freeze({
    id: "free",
    label: "Free",
    capabilities: Object.freeze(["frontier.max", "frontier.gemini", "voice.vibevoice"]),
  }),
  pro: Object.freeze({
    id: "pro",
    label: "Pro",
    capabilities: Object.freeze(["frontier.escalation", "frontier.max", "frontier.gemini", "voice.vibevoice"]),
  }),
});

/** The plan an app falls back to with no licence, an invalid one, or an expired one. */
export const DEFAULT_PLAN = "free";

/**
 * Which capability a Frontier profile requires, if any.
 *
 * Keyed by the profile ids in gateway/frontier-runner.js `PROFILES`. A profile
 * absent from this map requires nothing and is always available — which is the
 * correct default, because a new local profile should not become unreachable
 * merely because nobody remembered to register it.
 *
 * `auto` is here because escalation is the whole point of the Auto lane: it
 * begins locally and hands off to Claude Sonnet when the task earns it, and a
 * free user is offered Flash instead rather than an Auto that silently never
 * escalates. Presenting a degraded lane under its full name would be the worse
 * outcome — the user would conclude the router is broken, not that they are
 * unsubscribed.
 */
export const PROFILE_CAPABILITY = Object.freeze({
  auto: "frontier.escalation",
  "claude-sonnet": "frontier.escalation",
  "claude-opus": "frontier.escalation",
  "local-expert": "frontier.max",
  max: "frontier.max",
  "frontier-max": "frontier.max",
});

/**
 * Which capability a voice tier requires. Absent means always available.
 *
 * `local` and `builtin` are absent on purpose: they are the floor every plan
 * gets, and the floor is what an unentitled user is quietly served instead of
 * an error.
 */
export const VOICE_TIER_CAPABILITY = Object.freeze({
  vibevoice: "voice.vibevoice",
});

/**
 * The capabilities a plan grants, as a plain array ready to sign into a licence.
 *
 * An unknown plan id resolves to the free list rather than to nothing. A typo
 * in a price record should cost a user their Pro features, not their ability
 * to open the app.
 */
export function capabilitiesForPlan(planId) {
  const plan = PLANS[planId] ?? PLANS[DEFAULT_PLAN];
  return [...plan.capabilities];
}

/** Is this a plan we know how to issue? Used to reject nonsense before it is signed. */
export function isKnownPlan(planId) {
  return Object.hasOwn(PLANS, planId);
}

/**
 * Does `capabilities` allow this Frontier profile?
 *
 * Exported as its own function rather than inlined at the gate so that the
 * gateway, the mode resolver and the UI all answer the question identically.
 * Three implementations of "may I" is three chances to disagree.
 */
export function profileAllowed(profileId, capabilities) {
  const required = PROFILE_CAPABILITY[profileId];
  if (!required) return true;
  return capabilities.includes(required);
}

/** Does `capabilities` allow this voice tier? */
export function voiceTierAllowed(tierId, capabilities) {
  const required = VOICE_TIER_CAPABILITY[tierId];
  if (!required) return true;
  return capabilities.includes(required);
}
