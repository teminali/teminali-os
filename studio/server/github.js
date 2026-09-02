/**
 * GitHub connection.
 *
 * Two ways in, tried in order:
 *
 *   1. The `gh` CLI, if it is installed and already authenticated. This is the
 *      right default on a developer machine — the operator has already granted
 *      scopes, the token lives in the OS keychain, and the studio never has to
 *      hold a credential of its own.
 *   2. A personal access token, stored the same way provider keys are.
 *
 * Everything shells out with execFile and an argument array — never a shell
 * string — because repository names arrive from the network and a `;` in one
 * must be an invalid repo name, not a command separator.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const run = promisify(execFile);

/** Owner/name, the only shape we will pass to git or gh. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** A directory name we are willing to create inside the workspace. */
const DIRECTORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const GH_TIMEOUT_MS = 15_000;
const CLONE_TIMEOUT_MS = 300_000;

async function gh(args, { timeout = GH_TIMEOUT_MS, cwd } = {}) {
  return run("gh", args, { timeout, cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

/**
 * What we can do with GitHub right now. Never throws: "not connected" is an
 * ordinary answer and the interface has to be able to render it.
 */
export async function githubStatus({ token = null } = {}) {
  // 1. The CLI.
  try {
    const { stdout: version } = await gh(["--version"], { timeout: 5000 });
    const cliVersion = version.split("\n")[0]?.trim() ?? null;

    try {
      const { stdout } = await gh(["api", "user", "--jq", "{login: .login, name: .name, avatar: .avatar_url}"]);
      const user = JSON.parse(stdout);
      const scopes = await cliScopes();
      return {
        connected: true,
        method: "cli",
        cliVersion,
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatar ?? null,
        scopes,
        canClone: scopes.includes("repo"),
        detail: null,
      };
    } catch {
      return {
        connected: false,
        method: null,
        cliVersion,
        detail: "The GitHub CLI is installed but not signed in. Run `gh auth login`.",
        canAuthenticate: true,
      };
    }
  } catch {
    /* No CLI. Fall through to the token path. */
  }

  // 2. A stored token.
  if (token) {
    try {
      const response = await fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(GH_TIMEOUT_MS),
      });
      if (response.ok) {
        const user = await response.json();
        const scopes = (response.headers.get("x-oauth-scopes") ?? "")
          .split(",").map((scope) => scope.trim()).filter(Boolean);
        return {
          connected: true,
          method: "token",
          cliVersion: null,
          login: user.login,
          name: user.name ?? null,
          avatarUrl: user.avatar_url ?? null,
          scopes,
          canClone: scopes.includes("repo") || scopes.length === 0,
          detail: null,
        };
      }
      return { connected: false, method: null, detail: `GitHub rejected the stored token (${response.status}).` };
    } catch {
      return { connected: false, method: null, detail: "GitHub could not be reached." };
    }
  }

  return {
    connected: false,
    method: null,
    cliVersion: null,
    detail: "Install the GitHub CLI and run `gh auth login`, or paste a personal access token.",
    canAuthenticate: false,
  };
}

async function cliScopes() {
  try {
    // `gh auth status` prints scopes; there is no JSON form for it.
    const { stdout, stderr } = await gh(["auth", "status"]).catch((error) => ({
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }));
    const match = /Token scopes:\s*(.+)/.exec(`${stdout}\n${stderr}`);
    if (!match) return [];
    return match[1].split(",").map((scope) => scope.trim().replace(/^'|'$/g, "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** The operator's repositories, most recently pushed first. */
export async function listRepos({ token = null, limit = 60 } = {}) {
  const bounded = Math.max(1, Math.min(200, Number(limit) || 60));

  try {
    const { stdout } = await gh([
      "repo", "list",
      "--limit", String(bounded),
      "--json", "name,nameWithOwner,description,isPrivate,isFork,primaryLanguage,pushedAt,url,diskUsage,stargazerCount",
    ]);
    return { source: "cli", repos: JSON.parse(stdout).map(normaliseCliRepo) };
  } catch {
    /* Fall through to the API. */
  }

  if (!token) return { source: null, repos: [], detail: "Not connected to GitHub." };

  const response = await fetch(
    `https://api.github.com/user/repos?per_page=${bounded}&sort=pushed&affiliation=owner,collaborator`,
    { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(GH_TIMEOUT_MS) },
  );
  if (!response.ok) {
    throw Object.assign(new Error(`GitHub returned ${response.status}.`), { status: 502, code: "GITHUB_LIST_FAILED" });
  }
  return { source: "api", repos: (await response.json()).map(normaliseApiRepo) };
}

function normaliseCliRepo(repo) {
  return {
    name: repo.name,
    fullName: repo.nameWithOwner,
    description: repo.description ?? null,
    private: Boolean(repo.isPrivate),
    fork: Boolean(repo.isFork),
    language: repo.primaryLanguage?.name ?? null,
    pushedAt: repo.pushedAt ?? null,
    url: repo.url,
    sizeKb: repo.diskUsage ?? null,
    stars: repo.stargazerCount ?? 0,
  };
}

function normaliseApiRepo(repo) {
  return {
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description ?? null,
    private: Boolean(repo.private),
    fork: Boolean(repo.fork),
    language: repo.language ?? null,
    pushedAt: repo.pushed_at ?? null,
    url: repo.html_url,
    sizeKb: repo.size ?? null,
    stars: repo.stargazers_count ?? 0,
  };
}

/**
 * Clone a repository into a directory beside the workspace root.
 *
 * The destination is derived from the repo name and validated, then resolved
 * and re-checked against the parent — a repo called `../../etc` must fail here,
 * not somewhere deeper.
 */
export async function cloneRepo(fullName, { parentDir, directory = null, token = null }) {
  if (!REPO_PATTERN.test(String(fullName ?? ""))) {
    throw Object.assign(new Error("A repository must be given as owner/name."), {
      status: 400, code: "INVALID_REPOSITORY",
    });
  }

  const target = directory ?? String(fullName).split("/")[1];
  if (!DIRECTORY_PATTERN.test(target)) {
    throw Object.assign(new Error("That destination directory name is not allowed."), {
      status: 400, code: "INVALID_DIRECTORY",
    });
  }

  const destination = path.resolve(parentDir, target);
  const parent = path.resolve(parentDir);
  if (destination !== parent && !destination.startsWith(parent + path.sep)) {
    throw Object.assign(new Error("The destination escapes the projects directory."), {
      status: 400, code: "DIRECTORY_ESCAPE",
    });
  }
  if (fs.existsSync(destination)) {
    throw Object.assign(new Error(`${target} already exists in the projects directory.`), {
      status: 409, code: "DIRECTORY_EXISTS",
    });
  }

  fs.mkdirSync(parent, { recursive: true });

  try {
    await gh(["repo", "clone", fullName, destination, "--", "--depth", "1"], { timeout: CLONE_TIMEOUT_MS });
    return { path: destination, name: target, method: "cli" };
  } catch (cliError) {
    if (!token) {
      throw Object.assign(new Error(`Clone failed: ${trimError(cliError)}`), {
        status: 502, code: "GITHUB_CLONE_FAILED",
      });
    }
    // Token fallback. The credential goes in the URL for this one call and is
    // never written to a remote, because --depth 1 clones set no credential
    // helper and we rewrite the origin immediately afterwards.
    try {
      await run("git", ["clone", "--depth", "1", `https://x-access-token:${token}@github.com/${fullName}.git`, destination], {
        timeout: CLONE_TIMEOUT_MS,
      });
      await run("git", ["remote", "set-url", "origin", `https://github.com/${fullName}.git`], { cwd: destination });
      return { path: destination, name: target, method: "token" };
    } catch (gitError) {
      throw Object.assign(new Error(`Clone failed: ${trimError(gitError)}`), {
        status: 502, code: "GITHUB_CLONE_FAILED",
      });
    }
  }
}

function trimError(error) {
  const text = String(error?.stderr || error?.message || error);
  // Never surface a token that appeared in a clone URL.
  return text.replace(/x-access-token:[^@]+@/g, "x-access-token:***@").split("\n").slice(0, 3).join(" ").trim();
}
