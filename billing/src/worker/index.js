/**
 * Teminali OS billing — the whole API surface.
 *
 * Hand-rolled routing, on purpose and to match the rest of the product.
 * teminaliCode has no framework anywhere: the gateway is raw `node:http` with
 * manual routing, and this is the money path, where being able to read a
 * request from entry to response without stepping through a middleware chain
 * is worth more than the forty lines a router would save. It is also one less
 * dependency in the code that grants entitlements.
 *
 * The paths under `/api/device` and `/api/licence` are not free choices — the
 * client half already exists in `studio/server/licence.js` and calls exactly
 * these, with exactly these field names. Changing one means changing a
 * shipped desktop build.
 *
 *     GET    /health
 *
 *     POST   /api/device/start          the app asks for a code
 *     POST   /api/device/poll           …and polls until someone approves it
 *     POST   /api/licence               session token in, signed licence out
 *     GET    /api/me
 *     POST   /api/signout
 *
 *     GET    /api/plans                 public price list
 *     POST   /api/checkout/stripe       card
 *     POST   /api/checkout/lipia        mobile money
 *     GET    /api/orders/:id
 *
 *     POST   /webhooks/stripe
 *     POST   /webhooks/lipia
 */

import { deviceStart, devicePoll, me, signOut } from "./auth.js";
import { listPlans } from "./catalogue.js";
import { cors, fail, json } from "./http.js";
import { postLicence } from "./licence.js";
import * as lipia from "./lipia.js";
import { getOrder } from "./orders.js";
import { sweep } from "./reconcile.js";
import * as stripe from "./stripe.js";

export default {
  /**
   * The two-minute tick. See `reconcile.js` — it settles orders nobody is
   * watching, prompts Lipia renewals, and retires subscriptions that lapsed.
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      sweep(env).then((result) => {
        // Read with `wrangler tail`. A sweep that quietly does nothing for a
        // week looks exactly like a sweep that had nothing to do.
        console.log("sweep", JSON.stringify(result));
      }),
    );
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    const segments = path.split("/").filter(Boolean);

    try {
      if (path === "/health") return json({ ok: true, service: "teminali-billing" });

      /* ── account ── */
      if (method === "POST" && path === "/api/device/start") return deviceStart(request, env);
      if (method === "POST" && path === "/api/device/poll") return devicePoll(request, env);
      if (method === "POST" && path === "/api/licence") return postLicence(request, env);
      if (method === "GET" && path === "/api/me") return me(request, env);
      if (method === "POST" && path === "/api/signout") return signOut(request, env);

      /* ── buying ── */
      if (method === "GET" && path === "/api/plans") return listPlans(request, env);
      if (method === "POST" && path === "/api/checkout/stripe") return stripe.checkout(request, env);
      if (method === "POST" && path === "/api/checkout/lipia") return lipia.checkout(request, env);
      if (method === "GET" && segments[0] === "api" && segments[1] === "orders" && segments[2]) {
        return getOrder(request, env, segments[2]);
      }

      /* ── the gateways calling us ── */
      if (method === "POST" && path === "/webhooks/stripe") return stripe.webhook(request, env);
      if (method === "POST" && path === "/webhooks/lipia") return lipia.webhook(request, env);

      return fail(404, "NOT_FOUND", `${method} ${path}`);
    } catch (error) {
      // Never leak a stack to a client, and never swallow one either —
      // `wrangler tail` is where this is read, and an error that only ever
      // appeared as a 500 is an error nobody can fix.
      console.error("unhandled", method, path, error);
      return fail(500, "INTERNAL_ERROR", "Something went wrong on our side.");
    }
  },
};
