/**
 * One order, for the buyer who is standing there waiting.
 *
 * Reconciles on read rather than only on the cron tick, because the two minutes
 * between sweeps is exactly the time somebody spends staring at a spinner
 * deciding whether the payment worked. Same `settle`, so a read racing a
 * webhook settles once.
 */

import { userForToken } from "./db.js";
import { bearer, fail, json } from "./http.js";
import * as lipia from "./lipia.js";

export async function getOrder(request, env, orderId) {
  const user = await userForToken(env, bearer(request));
  if (!user) return fail(401, "NOT_SIGNED_IN", "Sign in to see this order.");

  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(orderId, user.id).first();
  // Scoped to the caller's own orders, and a stranger's order is "not found"
  // rather than "forbidden" — the second answer confirms the id exists.
  if (!order) return fail(404, "UNKNOWN_ORDER", "No such order.");

  let current = order;
  if (order.rail === "lipia" && order.lipia_transaction_id && (order.status === "created" || order.status === "charging")) {
    try {
      const answer = await lipia.getTransaction(env, order.lipia_transaction_id);
      await lipia.settle(env, order, answer?.data ?? {});
      current = (await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(order.id).first()) ?? order;
    } catch {
      // Lipia unreachable. The cached row is still the honest answer, and the
      // sweep will catch up.
    }
  }

  return json({
    order: {
      id: current.id,
      status: current.status,
      kind: current.kind,
      plan: current.plan_id,
      amount: current.amount,
      currency: current.currency,
      rail: current.rail,
      failureReason: current.failure_reason,
      createdAt: current.created_at,
      updatedAt: current.updated_at,
    },
  });
}
