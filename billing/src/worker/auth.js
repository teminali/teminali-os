/**
 * Sign-in, by OAuth device flow.
 *
 * A desktop app cannot complete a browser redirect: there is no URL the
 * provider can send the user back to that only this process can receive, and a
 * loopback listener is a port anything else on the machine can race for. So
 * the browser half and the app half are joined by a short code the person
 * types. Teminali Code shows the code, the person authorises in whatever
 * browser they already trust, and the app polls until it is done.
 *
 * **The app polls US, not the provider.** That is the whole design:
 *
 *   - the provider's client secret never ships inside an Electron app, where
 *     it would be one `asar` extract away;
 *   - the account row is created as a side effect of an exchange WE performed,
 *     rather than trusted from a token the client handed us;
 *   - and the poll interval is enforced here, so one client bug cannot burn
 *     the OAuth quota for every other user.
 *
 * Nothing is simulated. A `pending` means the provider said pending.
 */

import { newId, randomToken, sha256Hex } from "./crypto.js";
import { now, subscriptionEntitles, tooManyDeviceStarts, userForToken } from "./db.js";
import { bearer, clientIp, fail, json, readJson } from "./http.js";
import { issueLicenceFor } from "./licence.js";

/**
 * Ninety days.
 *
 * Long, because this session's only power is to ask for a licence — it cannot
 * change a subscription, cannot see a card, and cannot spend money. Making a
 * developer sign in monthly to keep an editor working would buy nothing.
 */
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/* ── Provider adapters ─────────────────────────────────────────────
   One shape, two implementations. Both device flows are RFC 8628; they differ
   only in field names and in where the profile comes from. */

const PROVIDERS = {
  github: {
    deviceUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    clientId: (env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
    verificationUrl: (d) => d.verification_uri,
    async profile(accessToken) {
      const headers = {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        // GitHub rejects API calls with no User-Agent outright.
        "user-agent": "teminali-billing",
      };
      const response = await fetch("https://api.github.com/user", { headers });
      if (!response.ok) throw new Error(`GitHub /user returned ${response.status}`);
      const profile = await response.json();

      // A GitHub profile email is null whenever the address is private, which
      // is the default. A receipt has to go somewhere.
      let email = profile.email ?? null;
      if (!email) {
        const emails = await fetch("https://api.github.com/user/emails", { headers });
        if (emails.ok) {
          const list = await emails.json();
          email = list.find((entry) => entry.primary && entry.verified)?.email ?? null;
        }
      }
      return { sub: String(profile.id), email, name: profile.name ?? profile.login ?? null, avatar: profile.avatar_url ?? null };
    },
  },
  google: {
    deviceUrl: "https://oauth2.googleapis.com/device/code",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    // Google calls it verification_url; GitHub calls it verification_uri.
    verificationUrl: (d) => d.verification_url ?? d.verification_uri,
    async profile(accessToken) {
      const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error(`Google userinfo returned ${response.status}`);
      const profile = await response.json();
      return { sub: profile.sub, email: profile.email ?? null, name: profile.name ?? null, avatar: profile.picture ?? null };
    },
  },
};

/** The default when the client names no provider. */
export const DEFAULT_PROVIDER = "github";

async function form(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  return (await response.json().catch(() => ({}))) ?? {};
}

/* ── POST /api/device/start ────────────────────────────────────── */

export async function deviceStart(request, env) {
  const body = await readJson(request);
  const providerId = typeof body?.provider === "string" ? body.provider : DEFAULT_PROVIDER;
  const provider = PROVIDERS[providerId];
  if (!provider) return fail(400, "UNKNOWN_PROVIDER", 'provider must be "github" or "google"');

  if (!provider.clientId(env) || !provider.clientSecret(env)) {
    return fail(503, "PROVIDER_NOT_CONFIGURED", `${providerId} sign-in is not set up on this server.`);
  }

  // Checked BEFORE the provider is called, which is the entire point: the
  // thing being protected is our OAuth quota, and a limit applied after the
  // round trip protects nothing.
  const ip = clientIp(request);
  if (await tooManyDeviceStarts(env, ip)) {
    return fail(429, "TOO_MANY_ATTEMPTS", "Too many sign-in attempts. Wait a few minutes and try again.");
  }

  const answer = await form(provider.deviceUrl, { client_id: provider.clientId(env), scope: provider.scope });
  if (!answer.device_code || !answer.user_code) {
    return fail(502, "PROVIDER_ERROR", answer.error_description ?? answer.error ?? "No device code was returned.");
  }

  const deviceCode = newId("dev");
  const interval = Number(answer.interval ?? 5);
  const expiresIn = Number(answer.expires_in ?? 900);
  const verificationUrl = provider.verificationUrl(answer);
  const deviceName = typeof body?.deviceName === "string" ? body.deviceName.slice(0, 120) : null;

  await env.DB.prepare(
    `INSERT INTO device_auths
       (id, provider, provider_device_code, user_code, verification_url, interval_s, device_name,
        created_at, expires_at, status, last_polled_at, created_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
  )
    .bind(deviceCode, providerId, answer.device_code, answer.user_code, verificationUrl, interval, deviceName, now(), now() + expiresIn * 1000, ip)
    .run();

  return json({
    deviceCode,
    userCode: answer.user_code,
    verificationUrl,
    // Google returns a prefilled URL; GitHub does not. The app shows the plain
    // one when this is absent rather than building its own.
    verificationUrlComplete: answer.verification_url_complete ?? null,
    interval,
    expiresIn,
  });
}

/* ── POST /api/device/poll ─────────────────────────────────────── */

export async function devicePoll(request, env) {
  const body = await readJson(request);
  if (!body?.deviceCode) return fail(400, "MISSING_DEVICE_CODE", "No sign-in is in progress.");

  const row = await env.DB.prepare("SELECT * FROM device_auths WHERE id = ?").bind(body.deviceCode).first();
  if (!row) return fail(404, "UNKNOWN_DEVICE_CODE", "This sign-in code is not one we issued.");

  if (row.status === "denied") return json({ status: "denied" });
  if (row.status === "expired" || row.expires_at < now()) {
    await env.DB.prepare("UPDATE device_auths SET status = 'expired' WHERE id = ?").bind(row.id).run();
    return json({ status: "expired" });
  }
  // A code that already completed must not mint a second session. The app
  // stores the first answer and stops polling, so a repeat is a retry after a
  // dropped response — and handing it a fresh session would leave a live
  // credential nobody is holding.
  if (row.status === "complete") return json({ status: "already_claimed" });

  // Enforce the provider's own interval here. A client polling in a tight loop
  // gets slow_down from us and never reaches the provider, so one misbehaving
  // desktop cannot rate-limit sign-in for everybody.
  if (now() - row.last_polled_at < row.interval_s * 1000) {
    return json({ status: "slow_down", interval: row.interval_s });
  }
  await env.DB.prepare("UPDATE device_auths SET last_polled_at = ? WHERE id = ?").bind(now(), row.id).run();

  const provider = PROVIDERS[row.provider];
  const token = await form(provider.tokenUrl, {
    client_id: provider.clientId(env),
    client_secret: provider.clientSecret(env),
    device_code: row.provider_device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  if (token.error === "authorization_pending") return json({ status: "pending" });
  if (token.error === "slow_down") return json({ status: "slow_down", interval: row.interval_s + 5 });
  if (token.error === "access_denied") {
    await env.DB.prepare("UPDATE device_auths SET status = 'denied' WHERE id = ?").bind(row.id).run();
    return json({ status: "denied" });
  }
  if (token.error === "expired_token") {
    await env.DB.prepare("UPDATE device_auths SET status = 'expired' WHERE id = ?").bind(row.id).run();
    return json({ status: "expired" });
  }
  if (!token.access_token) {
    return fail(502, "PROVIDER_ERROR", token.error_description ?? token.error ?? "No access token was returned.");
  }

  /* Authorised. Everything below happens exactly once per device code. */
  let profile;
  try {
    profile = await provider.profile(token.access_token);
  } catch (error) {
    return fail(502, "PROVIDER_ERROR", error.message);
  }

  const user = await upsertUser(env, row.provider, profile);

  const sessionToken = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at, user_agent, device_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(sessionToken), user.id, now(), now(), now() + SESSION_TTL_MS, request.headers.get("user-agent"), row.device_name)
    .run();

  await env.DB.prepare("UPDATE device_auths SET status = 'complete', user_id = ? WHERE id = ?").bind(user.id, row.id).run();

  // The licence is issued here rather than left to the app's next refresh,
  // because a sign-in that returns a session and no entitlement reads to the
  // user as a purchase that did nothing.
  //
  // If signing is not configured this still returns the session. Signed in on
  // the free plan is a recoverable state — the next refresh picks the licence
  // up once the key is in place — whereas failing the sign-in leaves the user
  // with no account at all, possibly after a card has already been charged.
  let licence = null;
  try {
    ({ licence } = await issueLicenceFor(env, user));
  } catch (error) {
    console.error("licence issue failed at sign-in", user.id, error);
  }

  return json({
    status: "granted",
    sessionToken,
    licence,
    user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url },
  });
}

async function upsertUser(env, providerId, profile) {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE provider = ? AND provider_sub = ?").bind(providerId, profile.sub).first();
  if (existing) {
    await env.DB.prepare("UPDATE users SET email = ?, name = ?, avatar_url = ?, last_seen_at = ? WHERE id = ?")
      .bind(profile.email, profile.name, profile.avatar, now(), existing.id)
      .run();
    return { ...existing, email: profile.email, name: profile.name, avatar_url: profile.avatar };
  }

  const id = newId("usr");
  await env.DB.prepare(
    `INSERT INTO users (id, provider, provider_sub, email, name, avatar_url, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, providerId, profile.sub, profile.email, profile.name, profile.avatar, now(), now())
    .run();
  return { id, provider: providerId, provider_sub: profile.sub, email: profile.email, name: profile.name, avatar_url: profile.avatar, msisdn: null };
}

/* ── GET /api/me ───────────────────────────────────────────────── */

export async function me(request, env) {
  const user = await userForToken(env, bearer(request));
  if (!user) return fail(401, "NOT_SIGNED_IN", "Sign in to see this account.");

  const subscription = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY current_period_end DESC LIMIT 1")
    .bind(user.id)
    .first();

  return json({
    user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url, msisdn: user.msisdn, provider: user.provider },
    subscription: subscription
      ? {
          plan: subscription.plan_id,
          status: subscription.status,
          rail: subscription.rail,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
          entitled: subscriptionEntitles(subscription),
        }
      : null,
  });
}

/* ── POST /api/signout ─────────────────────────────────────────── */

export async function signOut(request, env) {
  const token = bearer(request);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  // Idempotent on purpose: signing out twice is not an error, and a client
  // that cannot sign out because it already did is a bad bug.
  return json({ ok: true });
}
