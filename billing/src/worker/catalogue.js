/**
 * What is for sale.
 *
 * Public and unauthenticated: the upgrade screen inside the app and the
 * upgrade page on the web both render from this, and neither has a session
 * yet. Nothing here is sensitive — a price list is a thing you publish.
 *
 * The capability descriptions come from `licence/entitlements.js` rather than
 * from the database, for the same reason the licence's capability list does:
 * that file is the single authority on what a plan unlocks, so an upgrade
 * screen cannot advertise something the licence will not actually grant.
 */

import { CAPABILITIES, PLANS, capabilitiesForPlan } from "../../../licence/entitlements.js";
import { json } from "./http.js";

export async function listPlans(request, env) {
  const { results: planRows } = await env.DB.prepare("SELECT * FROM plans WHERE status = 'active' ORDER BY sort_order ASC, id ASC").all();
  const { results: priceRows } = await env.DB.prepare("SELECT * FROM prices WHERE status = 'active' ORDER BY amount ASC").all();

  const plans = (planRows ?? []).map((plan) => ({
    id: plan.id,
    label: PLANS[plan.id]?.label ?? plan.label,
    blurb: plan.blurb,
    capabilities: capabilitiesForPlan(plan.id).map((id) => ({ id, ...CAPABILITIES[id] })),
    prices: (priceRows ?? [])
      .filter((price) => price.plan_id === plan.id)
      .map((price) => ({
        id: price.id,
        rail: price.rail,
        interval: price.interval,
        amount: price.amount,
        currency: price.currency,
      })),
  }));

  return json({ plans });
}
