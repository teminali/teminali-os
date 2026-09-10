/**
 * Hosted providers — catalogue, key storage, and lane routing.
 *
 * The studio offers two ways to run: local models, or a hosted API. This module
 * is the hosted half. It mirrors the local side deliberately: the same two
 * lanes (light for everyday work, heavy for hard work), chosen automatically,
 * so switching between local and hosted changes the cost profile and nothing
 * about how the product behaves.
 *
 * One rule shapes the defaults: **the flagship is never auto-selected.** Opus,
 * o-series, Ultra — they exist, they are listed, and Auto will not reach for
 * them on its own. A router that quietly picks the most expensive model on an
 * ambiguous prompt is a router nobody can budget for. The operator can pin one
 * explicitly; Auto will not.
 *
 * Keys are stored server-side with owner-only permissions and are never sent
 * back to the renderer — the API returns whether a key is configured and a
 * masked hint, never the secret.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Model IDs drift as providers ship. Every one of these is editable from the
 * settings pane and persisted alongside the key, so a rename never requires a
 * code change or a release.
 */
export const PROVIDERS = Object.freeze({
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    keyPrefix: "sk-ant-",
    docsUrl: "https://console.anthropic.com/settings/keys",
    lanes: {
      light: { model: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Fast and inexpensive; the default for everyday turns." },
      heavy: { model: "claude-sonnet-5", label: "Sonnet 5", note: "Used automatically when a task looks hard." },
    },
    flagship: { model: "claude-opus-5", label: "Opus 5", note: "Available, but never selected automatically." },
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    keyPrefix: "sk-",
    docsUrl: "https://platform.openai.com/api-keys",
    lanes: {
      light: { model: "gpt-4.1-mini", label: "GPT-4.1 mini", note: "Fast and inexpensive; the default for everyday turns." },
      heavy: { model: "gpt-4.1", label: "GPT-4.1", note: "Used automatically when a task looks hard." },
    },
    flagship: { model: "o3", label: "o3", note: "Available, but never selected automatically." },
  },
  google: {
    id: "google",
    label: "Google",
    envVar: "GEMINI_API_KEY",
    keyPrefixes: ["AI", "AQ"],
    docsUrl: "https://aistudio.google.com/apikey",
    lanes: {
      light: { model: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Fast and inexpensive; the default for everyday turns." },
      heavy: { model: "gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "Used automatically when a task looks hard." },
    },
    flagship: { model: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "Google flagship model for autonomous agentic coding." },
  },
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

/* ────────────────────────────────────────────────────────────────────────── */
/* Key storage                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/** Show enough of a key to recognise it, never enough to use it. */
export function maskKey(key) {
  const value = String(key ?? "");
  if (value.length <= 12) return value ? "•".repeat(value.length) : "";
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}

function emptyStore() {
  return { providers: {}, version: 1 };
}

export function readStore(storePath) {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? { ...emptyStore(), ...parsed } : emptyStore();
  } catch {
    return emptyStore();
  }
}

export function writeStore(storePath, store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  // Written 0600 and replaced atomically: a half-written key file would be
  // read back as "no key configured", which is a confusing way to fail.
  const temporary = `${storePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, storePath);
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {
    /* Filesystem does not support it; the content is still correct. */
  }
}

/**
 * Public view of provider configuration. Deliberately contains no secrets, so
 * it is safe to hand to the renderer and to log.
 */
export function describeProviders(store, environment = process.env) {
  return PROVIDER_IDS.map((id) => {
    const provider = PROVIDERS[id];
    const saved = store.providers?.[id] ?? {};
    // An environment variable counts as configured — that is how a CI or a
    // shell-launched gateway is expected to be set up.
    const fromEnv = Boolean(environment[provider.envVar]);
    const key = saved.key ?? (fromEnv ? environment[provider.envVar] : null);
    const backupEnvVar = `${provider.envVar}_BACKUP`;
    const fromBackupEnv = Boolean(environment[backupEnvVar]);
    const backupKey = saved.backupKey ?? (fromBackupEnv ? environment[backupEnvVar] : null);

    return {
      id,
      label: provider.label,
      envVar: provider.envVar,
      docsUrl: provider.docsUrl,
      configured: Boolean(key),
      source: saved.key ? "stored" : fromEnv ? "environment" : null,
      hint: key ? maskKey(key) : null,
      backupConfigured: Boolean(backupKey),
      backupHint: backupKey ? maskKey(backupKey) : null,
      enabled: saved.enabled !== false && Boolean(key),
      lanes: {
        light: { ...provider.lanes.light, model: saved.lightModel ?? provider.lanes.light.model },
        heavy: { ...provider.lanes.heavy, model: saved.heavyModel ?? provider.lanes.heavy.model },
      },
      flagship: provider.flagship,
      updatedAt: saved.updatedAt ?? null,
    };
  });
}

/** Reject something that plainly is not a key before it is stored. */
export function validateKey(providerId, key) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { ok: false, message: `Unknown provider ${providerId}.` };
  const value = String(key ?? "").trim();
  if (!value) return { ok: false, message: "A key is required." };
  if (value.length < 20) return { ok: false, message: "That key is too short to be valid." };
  if (/\s/.test(value)) return { ok: false, message: "A key cannot contain whitespace." };
  const prefixes = provider.keyPrefixes || (provider.keyPrefix ? [provider.keyPrefix] : null);
  if (prefixes && !prefixes.some((p) => value.startsWith(p))) {
    return { ok: false, message: `${provider.label} keys start with “${prefixes.join("” or “")}”.` };
  }
  return { ok: true, value };
}

export function setProviderKey(store, providerId, key, backupKey = undefined) {
  const next = { ...store, providers: { ...store.providers } };
  const existing = next.providers[providerId] ?? {};
  next.providers[providerId] = {
    ...existing,
    key,
    ...(backupKey !== undefined ? { backupKey: backupKey ? String(backupKey).trim() : null } : {}),
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  return next;
}

export function clearProviderKey(store, providerId) {
  const next = { ...store, providers: { ...store.providers } };
  const existing = { ...(next.providers[providerId] ?? {}) };
  delete existing.key;
  delete existing.backupKey;
  existing.enabled = false;
  existing.updatedAt = new Date().toISOString();
  next.providers[providerId] = existing;
  return next;
}

export function setProviderLanes(store, providerId, { lightModel, heavyModel, enabled }) {
  const next = { ...store, providers: { ...store.providers } };
  next.providers[providerId] = {
    ...(next.providers[providerId] ?? {}),
    ...(lightModel !== undefined ? { lightModel } : {}),
    ...(heavyModel !== undefined ? { heavyModel } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    updatedAt: new Date().toISOString(),
  };
  return next;
}

/** The key a request should use, or null. Never leaves the server. */
export function resolveKey(store, providerId, environment = process.env) {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;
  return store.providers?.[providerId]?.key ?? environment[provider.envVar] ?? null;
}

/** The backup key a request should fall back to on rate limits, or null. */
export function resolveBackupKey(store, providerId, environment = process.env) {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;
  const backupEnvVar = `${provider.envVar}_BACKUP`;
  return store.providers?.[providerId]?.backupKey ?? environment[backupEnvVar] ?? null;
}

/**
 * Pick the hosted model for a lane, from the first enabled provider in
 * preference order. Mirrors planRouting on the local side.
 */
export function planHostedRouting(described, { preferred = null } = {}) {
  const enabled = described.filter((provider) => provider.enabled);
  if (enabled.length === 0) return { light: null, heavy: null, provider: null, degraded: true };

  const chosen = (preferred && enabled.find((provider) => provider.id === preferred)) ?? enabled[0];
  return {
    provider: chosen.id,
    providerLabel: chosen.label,
    light: { ...chosen.lanes.light, provider: chosen.id },
    heavy: { ...chosen.lanes.heavy, provider: chosen.id },
    // Stated explicitly so the interface can explain the omission rather than
    // leaving the operator to wonder where the flagship went.
    flagshipExcluded: chosen.flagship,
    degraded: false,
  };
}
