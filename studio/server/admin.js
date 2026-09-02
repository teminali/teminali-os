/**
 * Who is allowed to run privileged tools.
 *
 * Identity comes from GitHub — the same connection the sidebar already shows —
 * because it is the only account the studio actually authenticates against.
 * Admin is then an allowlist of logins.
 *
 * Be precise about what this is: on a local-first studio the GitHub identity is
 * *whoever is signed in to `gh` on this machine*. It answers "which of my
 * accounts is this" and gates a tool that can spend real money and run agents
 * loose in sandboxes. It is not a multi-tenant authorization system and must
 * not be relied on as one — anybody with a shell on this machine can run `gh
 * auth login` as themselves.
 *
 * The gate lives on the server. Hiding a panel in the renderer is a courtesy to
 * the operator, not a control: the routes themselves refuse.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { githubStatus } from "./github.js";

/** A GitHub login we are willing to store. */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function isValidLogin(login) {
  return typeof login === "string" && LOGIN_PATTERN.test(login);
}

/**
 * The allowlist.
 *
 * Two sources, both honoured: `TEMINALI_ADMINS` for a deployment that wants it
 * fixed and unwritable, and a store file for one that wants it editable. The
 * env list wins and cannot be removed through the API, so a machine can be
 * configured such that no request can widen its own access.
 */
export async function readAdmins(storePath, environment = process.env) {
  const fromEnv = (environment.TEMINALI_ADMINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(isValidLogin);

  let fromStore = [];
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8"));
    if (Array.isArray(parsed?.admins)) fromStore = parsed.admins.filter(isValidLogin);
  } catch {
    /* No store yet. */
  }

  return {
    // Case-insensitive: GitHub logins are.
    logins: [...new Set([...fromEnv, ...fromStore].map((login) => login.toLowerCase()))],
    locked: fromEnv.map((login) => login.toLowerCase()),
  };
}

export async function writeAdmins(storePath, logins) {
  const admins = [...new Set(logins.filter(isValidLogin))];
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify({ admins }, null, 2)}\n`, "utf8");
  return admins;
}

/**
 * Who is asking, and may they.
 *
 * Never throws: "not connected" and "not an admin" are ordinary answers the
 * interface has to render, and an identity lookup that fails must deny rather
 * than crash the route.
 */
export async function whoami(storePath, { token = null } = {}) {
  const { logins, locked } = await readAdmins(storePath);

  let status = null;
  try {
    status = await githubStatus({ token });
  } catch {
    status = null;
  }

  const login = status?.connected ? status.login ?? null : null;
  const isAdmin = Boolean(login && logins.includes(login.toLowerCase()));

  return {
    connected: Boolean(status?.connected),
    login,
    name: status?.name ?? null,
    avatarUrl: status?.avatarUrl ?? null,
    isAdmin,
    admins: logins,
    lockedAdmins: locked,
    // When nobody is an admin yet, the first connected account may claim it.
    // A studio that ships with no way in is a studio nobody can administer;
    // once one admin exists this is false forever and the route refuses.
    canClaim: logins.length === 0 && Boolean(login),
    reason: !status?.connected
      ? "Connect GitHub to identify yourself."
      : isAdmin
        ? null
        : logins.length === 0
          ? "No administrator has been set for this studio yet."
          : `${login} is not an administrator of this studio.`,
  };
}

/** The gate. Returns the identity when allowed; throws `deny` when not. */
export async function requireAdmin(storePath, deny) {
  const identity = await whoami(storePath);
  if (!identity.isAdmin) throw deny(identity.reason ?? "Administrator access is required.");
  return identity;
}
