/**
 * What models the agent CLIs will actually accept.
 *
 * There is no models endpoint on either CLI — no `claude models`, no
 * `codex models`, and a bogus `--model` is rejected without the valid set being
 * printed. So this file assembles the answer from the three sources that are
 * genuinely true rather than inventing a list:
 *
 *   1. **The CLI's own documented aliases.** `claude --model` names them in its
 *      help ("an alias for the latest model (e.g. 'fable', 'opus', or
 *      'sonnet')"), and the alias table is what the binary resolves against.
 *      These are the interface; the dated ids underneath them are not.
 *   2. **The operator's own config**, read at runtime — `~/.codex/config.toml`
 *      and `~/.claude/settings.json`. Whatever is set there is what "Default"
 *      means on this machine, and it is a fact rather than a guess.
 *   3. **What the CLI reported it resolved**, harvested from the `system.init`
 *      event of every turn and remembered. This is the part that makes the list
 *      self-correcting: the first time you run Sonnet, the studio learns that
 *      the alias resolved to `claude-sonnet-5` on your install, and shows that
 *      from then on instead of a value baked in here.
 *
 * The `resolves` field is therefore marked with where it came from, and the UI
 * says so. A value we have merely shipped is not presented as a value we have
 * observed.
 *
 * Codex is the awkward one: for a ChatGPT-account login the supported set is
 * enforced server-side ("The 'x' model is not supported when using Codex with a
 * ChatGPT account"), and nothing local enumerates it. So its list is the model
 * the operator has actually configured plus the families the CLI ships with,
 * and a rejection is surfaced verbatim rather than pre-empted.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Claude Code's aliases. `resolves` is the shipped best-knowledge value and is
 * replaced by an observed one the moment a turn reports otherwise.
 */
const CLAUDE_MODELS = [
  { id: null, label: "Default", detail: "Whatever your Claude Code config selects" },
  { id: "opus", label: "Opus", resolves: "claude-opus-5", detail: "Most capable" },
  { id: "sonnet", label: "Sonnet", resolves: "claude-sonnet-5", detail: "Balanced — the everyday default" },
  { id: "haiku", label: "Haiku", resolves: "claude-haiku-4-5", detail: "Fastest, cheapest" },
  { id: "fable", label: "Fable", resolves: "claude-fable-5", detail: "Frontier reasoning" },
  { id: "opus[1m]", label: "Opus · 1M context", resolves: "claude-opus-5[1m]", detail: "Opus with the 1M-token window" },
  { id: "sonnet[1m]", label: "Sonnet · 1M context", resolves: "claude-sonnet-5[1m]", detail: "Sonnet with the 1M-token window" },
  { id: "opusplan", label: "Opus Plan", resolves: null, detail: "Opus to plan, Sonnet to execute" },
];

/**
 * Codex. Deliberately short: for a ChatGPT login the account decides, and a
 * long speculative list would be a list of things that mostly fail.
 */
const CODEX_MODELS = [
  { id: null, label: "Default", detail: "Whatever ~/.codex/config.toml selects" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", detail: "Codex's shipped default" },
  { id: "gpt-5.6-sol-mini", label: "GPT-5.6 Sol mini", detail: "Faster, lighter" },
];

const CATALOG = { claude: CLAUDE_MODELS, codex: CODEX_MODELS };

/* ── The operator's configured default ───────────────────────────────────── */

/** `model = "gpt-5.6-sol"` from the top of ~/.codex/config.toml. */
async function codexConfiguredModel(home = homedir()) {
  try {
    const text = await readFile(join(home, ".codex", "config.toml"), "utf8");
    for (const line of text.split("\n")) {
      // Only the root table: a `[projects."…"]` section below may set its own.
      if (line.startsWith("[")) break;
      const match = line.match(/^\s*model\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  } catch {
    /* No config, or unreadable. "Not set" is an ordinary answer. */
  }
  return null;
}

async function claudeConfiguredModel(home = homedir()) {
  try {
    const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    return typeof settings?.model === "string" ? settings.model : null;
  } catch {
    return null;
  }
}

/* ── Learned resolutions ─────────────────────────────────────────────────── */

export async function readResolutions(storePath) {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Records what a CLI actually resolved an alias to.
 *
 * Called with the `system.init` event's model for the alias that was requested.
 * Writing is best-effort: failing to remember a resolution must never fail the
 * turn that produced it.
 */
export async function recordResolution(storePath, engine, requested, resolved) {
  if (!resolved) return;
  const key = requested ?? "__default__";
  try {
    const store = await readResolutions(storePath);
    const forEngine = store[engine] ?? {};
    if (forEngine[key]?.resolved === resolved) return;
    forEngine[key] = { resolved, observedAt: new Date().toISOString() };
    store[engine] = forEngine;
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch {
    /* Best effort. */
  }
}

/* ── The assembled answer ────────────────────────────────────────────────── */

export async function agentModels({ storePath, home = homedir() } = {}) {
  const [observed, codexConfigured, claudeConfigured] = await Promise.all([
    storePath ? readResolutions(storePath) : Promise.resolve({}),
    codexConfiguredModel(home),
    claudeConfiguredModel(home),
  ]);

  const configured = { claude: claudeConfigured, codex: codexConfigured };

  const build = (engine) => {
    const seen = observed[engine] ?? {};
    const models = CATALOG[engine].map((entry) => {
      const key = entry.id ?? "__default__";
      const observation = seen[key];
      // A Claude entry is an alias and carries what it resolves to. A Codex
      // entry *is* the slug, so it resolves to itself.
      const shipped =
        entry.id === null
          ? configured[engine]
          : entry.resolves !== undefined
            ? entry.resolves
            : entry.id;
      return {
        id: entry.id,
        label: entry.label,
        detail: entry.detail,
        resolves: observation?.resolved ?? shipped ?? null,
        // Where that resolution came from, so the interface can be honest about
        // which of these it has actually seen happen.
        source: observation ? "observed" : entry.id === null ? (configured[engine] ? "config" : "unknown") : "catalog",
        observedAt: observation?.observedAt ?? null,
      };
    });
    return { configured: configured[engine], models };
  };

  return { claude: build("claude"), codex: build("codex") };
}
