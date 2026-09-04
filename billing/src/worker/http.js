/**
 * Request and response plumbing. Small on purpose: this is the money path,
 * and being able to read a request from entry to response without stepping
 * through a framework's middleware chain is worth more than the forty lines a
 * router would save.
 *
 * The error shape is not a matter of taste here. The client half already
 * exists — `billingCall` in `studio/server/licence.js` reads
 * `body.error.code` and `body.error.message` — so an error is a nested object
 * with both fields, always. A bare string would surface in the desktop app as
 * "The billing service answered 400" with the actual reason discarded.
 */

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(), ...extra },
  });
}

/** `code` is for the client to branch on; `message` is for a person to read. */
export function fail(status, code, message) {
  return json({ error: { code, message: message ?? code } }, status);
}

/**
 * CORS.
 *
 * The desktop app does not need this: its calls come from the local gateway,
 * a Node process, which sends no Origin at all. It is here for the upgrade
 * page on the web, which reads `/api/plans` to render prices. Wide open is
 * safe because every mutating route requires a bearer token rather than a
 * cookie — there is no ambient authority for a cross-site request to ride on.
 */
export function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
  };
}

export function bearer(request) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** The caller's IP, for the rate limits. */
export function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
