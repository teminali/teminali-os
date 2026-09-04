# Teminali Code billing

The service that decides who is paying, and signs a licence saying so.

It is a Cloudflare Worker with a D1 database, deployed separately and **never
packaged into the app**. The desktop half — `licence/format.js` and
`studio/server/licence.js` — only verifies what this service signs.

```
billing/
  wrangler.jsonc          Worker + D1 + the two-minute cron
  schema.sql              the whole database
  seed.sql                the plan and its prices (placeholder amounts)
  scripts/keygen.mjs      generate a signing keypair
  src/licence.js          the Node signer — tests and tooling only
  src/worker/             the deployed service
  tests/                  what can be tested without a network
```

## Why a database at all

teminaliCode has no framework and no database: the gateway is raw `node:http`
with manual routing and JSON on disk, and that stays true. This is the one
thing the app cannot hold. The desktop process runs on hardware the user
controls, so a `plan: "pro"` written anywhere on their machine is a ten-second
edit. The authority lives here; the app verifies a signature.

That split is also why this Worker exists rather than teminaliCut's: the two
products sell different things to different accounts, and sharing a store would
mean one product's outage is the other's.

## Routes

The paths under `/api/device` and `/api/licence` are **not free choices** — the
client half already ships in `studio/server/licence.js` and calls exactly these
with exactly these field names.

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | — | Liveness. |
| `POST` | `/api/device/start` | — | `{ provider?, deviceName? }` in; `{ deviceCode, userCode, verificationUrl, interval, expiresIn }` out. |
| `POST` | `/api/device/poll` | — | `{ deviceCode }` in; `pending` / `slow_down` / `denied` / `expired` / `already_claimed`, or `granted` with `sessionToken` and `licence`. |
| `POST` | `/api/licence` | bearer | Session token in, freshly signed licence out. |
| `GET` | `/api/me` | bearer | The account and its subscription. |
| `POST` | `/api/signout` | bearer | Deletes the session. Idempotent. |
| `GET` | `/api/plans` | — | The public price list, with capability descriptions from `licence/entitlements.js`. |
| `POST` | `/api/checkout/stripe` | bearer | `{ priceId }` in, a Checkout URL out. |
| `POST` | `/api/checkout/lipia` | bearer | `{ priceId, msisdn }` in, a charge prompt on the handset. |
| `GET` | `/api/orders/:id` | bearer | One order, reconciled against Lipia on read. |
| `POST` | `/webhooks/stripe` | signature | Verified over the raw body before it is parsed. |
| `POST` | `/webhooks/lipia` | signature | Same order: verify, log, then parse. |

Errors are `{ "error": { "code", "message" } }`, always — the desktop client
reads both fields, and a bare string would surface as "the billing service
answered 400" with the reason discarded.

## The two rails

**Stripe** owns its own renewals. It charges the card and tells us by webhook;
our job is to keep `subscriptions` in step with what Stripe already decided.

**Lipia** (mobile money, via `pay.mhasibudigital.com`) has no recurring
primitive at all — no stored mandate, nothing to charge. A renewal is a fresh
prompt on the user's handset, scheduled by our own cron two days before the
period ends. That is why `subscriptions` carries `msisdn`, `renew_after` and
`renew_attempts`, and why those columns are null on a Stripe row: a Stripe
subscription appearing in the renewal sweep would be a second charge for a
period already paid.

Both settle through `markOrderPaid` in `src/worker/fulfil.js`, which is what
makes a webhook racing the reconcile sweep grant one period rather than two.

## The licence

Signed Ed25519 over the payload built by `buildLicencePayload` in
`licence/format.js` — shared with the app so the two halves cannot drift. Two
rules are enforced in `src/worker/licence.js`:

- **The capability list comes from `licence/entitlements.js`**, never from the
  database. That file is the single authority on what a plan unlocks.
- **A licence never outlives the money.** The TTL is clamped to the end of the
  subscription's dunning window, so a seven-day token issued the day before a
  period ends cannot keep paying out for a week after it did.

## Setting one up

```bash
cd billing
npm install

npx wrangler d1 create teminali-billing     # paste database_id into wrangler.jsonc
npm run db:remote                           # apply schema.sql
npm run seed:remote                         # the plan and its prices — EDIT THE AMOUNTS FIRST

npm run keygen -- live-1                    # prints both halves and where each goes
npx wrangler secret put LICENCE_SIGNING_KEY
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put LIPIA_PUBLIC_KEY
npx wrangler secret put LIPIA_SECRET
npx wrangler secret put LIPIA_WEBHOOK_SECRET

npm run deploy
```

Then point the app at it with `TEMINALI_BILLING_URL`.

**The public key is the step that is easy to forget.** `BAKED_PUBLIC_KEYS` in
`studio/server/licence.js` is empty in this checkout, so no build honours any
licence yet and every user resolves to free however correct this Worker is.
`npm run keygen` prints the entry to paste, keyed by the `LICENCE_KEY_ID` in
`wrangler.jsonc`. Publish the public key in a release **before** switching
`LICENCE_KEY_ID` to it — a licence stamped with a key id no build carries is a
licence nobody can verify.

Local development wants `.dev.vars` (copy `.dev.vars.example`), `npm run
db:local`, `npm run seed:local` and `npm run dev`.

## Verification

```bash
npm test    # from the repository root — 143 tests, the billing ones included
```

The Worker's route handlers need D1 and a live payment gateway, so what is
tested is everything that can be wrong without a network: that a licence signed
here with WebCrypto verifies under the `node:crypto` verifier the app ships,
that the TTL clamp holds, that a monthly renewal on the 31st does not skip
February, that a stale or mis-signed Stripe delivery is rejected, and that every
shape a Tanzanian phone number is typed in normalises to one.
