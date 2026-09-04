#!/usr/bin/env node
/**
 * Generate a licence signing keypair, and print both halves where they go.
 *
 * Deliberately prints rather than writes. The private half belongs in
 * `wrangler secret put LICENCE_SIGNING_KEY` (or `.dev.vars`, which is
 * gitignored) and the public half belongs in `BAKED_PUBLIC_KEYS` in
 * `studio/server/licence.js`. A script that put either of them on disk for you
 * would eventually put the private one somewhere it got committed.
 *
 *     node scripts/keygen.mjs [key-id]
 */

import { generateLicenceKeypair } from "../src/licence.js";

const keyId = process.argv[2] ?? "dev-1";

const { privateKeyPem, publicKeyPem } = generateLicenceKeypair();

console.log(`\n── key id: ${keyId} ────────────────────────────────────────`);
console.log(`
1. The private half. Never commit it.

   Production:  npx wrangler secret put LICENCE_SIGNING_KEY
   Local:       paste this line into billing/.dev.vars

LICENCE_SIGNING_KEY="${privateKeyPem.trimEnd().replace(/\n/g, "\\n")}"

   And set LICENCE_KEY_ID in wrangler.jsonc vars to: ${keyId}
`);

console.log(`
2. The public half. This ships in every build — that is the point.

   Paste into BAKED_PUBLIC_KEYS in studio/server/licence.js:

  "${keyId}": ${JSON.stringify(publicKeyPem)},

   Until a key id appears there, the app honours no licence signed with it and
   every user resolves to the free plan, however correct the Worker is.
`);
