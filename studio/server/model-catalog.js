/**
 * Local model library — catalogue, fit analysis, and routing.
 *
 * Three concerns live here because they share one set of numbers:
 *
 *   1. What models exist in the Ollama library and what they actually cost in
 *      memory (`CATALOG`).
 *   2. Whether a given model will run *well* on this specific machine, which is
 *      arithmetic against the device's usable memory, not a guess (`fitFor`).
 *   3. Which of the installed models Frontier Auto should reach for at each
 *      weight class (`planRouting`).
 *
 * Everything here is pure — device and installed-model lists come in as
 * arguments — so all of it is testable without a machine or a running Ollama.
 */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/**
 * Runtime overhead beyond weights and KV cache: the Ollama process, the Metal
 * or CUDA compute buffers, and the activation working set. Measured empirically
 * at roughly half a gigabyte across model sizes.
 */
const RUNTIME_OVERHEAD_BYTES = 600 * MB;

/**
 * The context length the fit badge budgets against by default.
 *
 * Several models advertise a 128k window, but nobody runs a 3B model at 128k —
 * the KV cache alone would be several times the weights. Judging every model at
 * its theoretical maximum would mark small models "unsupported" for a workload
 * no one has. 16k is the honest working default for coding turns, and the
 * caller can pass any other value to see how the picture changes.
 */
export const PRACTICAL_CONTEXT_TOKENS = 16384;

/**
 * Fraction of a decode step that is memory-bandwidth bound, on a GPU backend.
 *
 * Measured, not assumed. Three decodes on one M4 Pro (273 GB/s, 100% GPU):
 *
 *   qwen2.5-coder:14b   8.4 GB   13.9 tok/s   implies 0.47
 *   devstral:24b       14.1 GB    6.0 tok/s   implies 0.31
 *   gpt-oss:20b        (sparse)  29.4 tok/s   see `activeBytes` below
 *
 * Efficiency is not actually constant — it falls as a model grows, because more
 * layers mean more kernel launches and more attention work per byte streamed —
 * but three points is not enough to fit a curve, so this is the single value
 * that lands closest across them, and it errs high on the largest. The earlier
 * 0.7 was optimistic by roughly 2x at the top of the range, which matters now
 * that `planRouting` refuses a heavy lane below MIN_HEAVY_TOKENS_PER_SECOND:
 * an inflated estimate waves through a model nobody will sit through.
 */
const BANDWIDTH_EFFICIENCY = 0.45;
/** CPU-only inference achieves far less of theoretical bandwidth. */
const CPU_BANDWIDTH_EFFICIENCY = 0.25;
/** Assumed DDR bandwidth when the host has no known accelerator, GB/s. */
const ASSUMED_CPU_BANDWIDTH = 50;

/**
 * The slowest the heavy lane is allowed to be, in tokens per second.
 *
 * Ten is where `speedBand` stops calling a model "steady" and starts calling it
 * "slow". An agent turn that emits several hundred tokens crosses a minute
 * below this, which is long enough that the stronger answer stops being worth
 * waiting for. The lane picks the strongest model that clears the bar rather
 * than the strongest model outright.
 */
const MIN_HEAVY_TOKENS_PER_SECOND = 10;

/**
 * Bytes per parameter across the Q4-family quantisations most local builds ship
 * in. Only used to rank a model whose parameter count is unknown — a hand-pulled
 * tag that matches no catalogue entry and whose Ollama metadata omits
 * `parameter_size`. Ranking those at zero would bury a 24B under a 3B.
 */
const ASSUMED_BYTES_PER_PARAM = 0.55;

/**
 * How strong a model is, for lane ranking: its parameter count, falling back to
 * what its file size implies. Deliberately not bytes — quantisation moves bytes
 * without moving capability, so an IQ3_M 27B would otherwise rank below a
 * Q4_K_M 24B despite being the larger model.
 */
function strengthOf(model) {
  if (model.params) return model.params;
  return (model.bytes ?? 0) / ASSUMED_BYTES_PER_PARAM;
}

/**
 * KV cache cost per token, in bytes, at fp16.
 *   2 (K and V) x layers x kv_heads x head_dim x 2 bytes
 * Stored per entry because grouped-query attention makes it impossible to infer
 * from parameter count alone — an 8B model with 8 KV heads and a 14B model with
 * 8 KV heads cost almost the same per token.
 *
 * `activeBytes` is the optional companion for mixture-of-experts entries: the
 * bytes a single decode step actually reads, which is what bounds speed. It is
 * measured, not computed. The naive share — active params / total params x file
 * size — puts GPT-OSS 20B at 2.2 GB, but every token also reads the full
 * attention stack and the router on top of its 4 of 32 experts. Measured at
 * 29.4 tok/s on an M4 Pro (273 GB/s, 20GB wired limit, 32k context, q8_0 KV,
 * 100% GPU), it back-solves through this formula to 4.2 GB: nearly double the
 * naive figure, and a third of the 13 GB the file occupies. Re-measure if the
 * entry is ever repointed at a different quantisation.
 */

/** @typedef {"code"|"reasoning"|"vision"|"general"|"embedding"|"autocomplete"} Capability */

/**
 * The shipped catalogue. Sizes are the published Q4_K_M download sizes unless
 * the tag names another quantisation. This is deliberately a static list: the
 * gateway is loopback-only and must work with no internet, so scraping the
 * library index at runtime is not an option.
 */
export const CATALOG = Object.freeze([
  /* ── Qwen 2.5 Coder — the coding workhorses ─────────────────────────── */
  { tag: "qwen2.5-coder:0.5b", name: "Qwen2.5 Coder 0.5B", family: "Qwen", params: 0.5e9, bytes: 0.4 * GB, kvPerToken: 24 * 1024, context: 32768, capabilities: ["code", "autocomplete"], useCase: "Inline autocomplete on very constrained machines.", tier: "tiny" },
  { tag: "qwen2.5-coder:1.5b", name: "Qwen2.5 Coder 1.5B", family: "Qwen", params: 1.5e9, bytes: 1.0 * GB, kvPerToken: 36 * 1024, context: 32768, capabilities: ["code", "autocomplete"], useCase: "Fast inline completion with usable quality.", tier: "tiny" },
  { tag: "qwen2.5-coder:3b", name: "Qwen2.5 Coder 3B", family: "Qwen", params: 3e9, bytes: 1.9 * GB, kvPerToken: 56 * 1024, context: 32768, capabilities: ["code", "autocomplete"], useCase: "Single-file edits and completion.", tier: "small" },
  { tag: "qwen2.5-coder:7b", name: "Qwen2.5 Coder 7B", family: "Qwen", params: 7.6e9, bytes: 4.7 * GB, kvPerToken: 112 * 1024, context: 32768, capabilities: ["code"], useCase: "Rapid edits, refactors within a file, autocomplete.", tier: "small" },
  { tag: "qwen2.5-coder:14b", name: "Qwen2.5 Coder 14B", family: "Qwen", params: 14.8e9, bytes: 9.0 * GB, kvPerToken: 192 * 1024, context: 32768, capabilities: ["code", "reasoning"], useCase: "Full-stack builds, multi-file refactoring, tool calling.", tier: "medium", flagship: true },
  { tag: "qwen2.5-coder:32b", name: "Qwen2.5 Coder 32B", family: "Qwen", params: 32.8e9, bytes: 20 * GB, kvPerToken: 256 * 1024, context: 32768, capabilities: ["code", "reasoning"], useCase: "The strongest open coding model; large refactors.", tier: "large" },

  /* ── Qwen 3 — general reasoning ─────────────────────────────────────── */
  { tag: "qwen3:0.6b", name: "Qwen3 0.6B", family: "Qwen", params: 0.6e9, bytes: 0.5 * GB, kvPerToken: 28 * 1024, context: 32768, capabilities: ["general"], useCase: "Classification and routing, not authoring.", tier: "tiny" },
  { tag: "qwen3:1.7b", name: "Qwen3 1.7B", family: "Qwen", params: 1.7e9, bytes: 1.4 * GB, kvPerToken: 40 * 1024, context: 32768, capabilities: ["general", "reasoning"], useCase: "Quick questions and short summaries.", tier: "tiny" },
  { tag: "qwen3:4b", name: "Qwen3 4B", family: "Qwen", params: 4e9, bytes: 2.5 * GB, kvPerToken: 72 * 1024, context: 32768, capabilities: ["general", "reasoning"], useCase: "Everyday assistant work on a laptop.", tier: "small" },
  { tag: "qwen3:8b", name: "Qwen3 8B", family: "Qwen", params: 8.2e9, bytes: 5.2 * GB, kvPerToken: 128 * 1024, context: 32768, capabilities: ["general", "reasoning", "code"], useCase: "Balanced reasoning and code for mid-range machines.", tier: "small" },
  { tag: "qwen3:14b", name: "Qwen3 14B", family: "Qwen", params: 14.8e9, bytes: 9.3 * GB, kvPerToken: 192 * 1024, context: 32768, capabilities: ["general", "reasoning", "code"], useCase: "Strong general reasoning with chain-of-thought.", tier: "medium" },
  { tag: "qwen3:32b", name: "Qwen3 32B", family: "Qwen", params: 32.8e9, bytes: 20 * GB, kvPerToken: 256 * 1024, context: 32768, capabilities: ["general", "reasoning", "code"], useCase: "Deep reasoning where latency does not matter.", tier: "large" },

  /* ── DeepSeek R1 — explicit reasoning ───────────────────────────────── */
  { tag: "deepseek-r1:1.5b", name: "DeepSeek R1 1.5B", family: "DeepSeek", params: 1.5e9, bytes: 1.1 * GB, kvPerToken: 36 * 1024, context: 32768, capabilities: ["reasoning"], useCase: "Chain-of-thought on very small machines.", tier: "tiny" },
  { tag: "deepseek-r1:7b", name: "DeepSeek R1 7B", family: "DeepSeek", params: 7.6e9, bytes: 4.7 * GB, kvPerToken: 112 * 1024, context: 32768, capabilities: ["reasoning", "code"], useCase: "Planning and architecture with visible reasoning.", tier: "small" },
  { tag: "deepseek-r1:8b", name: "DeepSeek R1 8B", family: "DeepSeek", params: 8e9, bytes: 4.9 * GB, kvPerToken: 128 * 1024, context: 32768, capabilities: ["reasoning", "code"], useCase: "Logic, planning, and step-by-step verification.", tier: "small" },
  { tag: "deepseek-r1:14b", name: "DeepSeek R1 14B", family: "DeepSeek", params: 14.8e9, bytes: 9.0 * GB, kvPerToken: 192 * 1024, context: 32768, capabilities: ["reasoning", "code"], useCase: "Harder debugging and root-cause analysis.", tier: "medium" },
  { tag: "deepseek-r1:32b", name: "DeepSeek R1 32B", family: "DeepSeek", params: 32.8e9, bytes: 20 * GB, kvPerToken: 256 * 1024, context: 32768, capabilities: ["reasoning", "code"], useCase: "The deepest local reasoning available.", tier: "large" },

  /* ── Mistral family ─────────────────────────────────────────────────── */
  { tag: "devstral:24b", name: "Devstral 24B", family: "Mistral", params: 24e9, bytes: 14 * GB, kvPerToken: 160 * 1024, context: 131072, capabilities: ["code", "reasoning"], useCase: "Agentic multi-file work with a very large context.", tier: "large" },
  { tag: "mistral:7b", name: "Mistral 7B", family: "Mistral", params: 7.2e9, bytes: 4.1 * GB, kvPerToken: 128 * 1024, context: 32768, capabilities: ["general"], useCase: "General instruction following.", tier: "small" },
  { tag: "mistral-nemo:12b", name: "Mistral Nemo 12B", family: "Mistral", params: 12.2e9, bytes: 7.1 * GB, kvPerToken: 160 * 1024, context: 131072, capabilities: ["general", "code"], useCase: "Long-context general work.", tier: "medium" },
  { tag: "mistral-small:24b", name: "Mistral Small 24B", family: "Mistral", params: 23.6e9, bytes: 14 * GB, kvPerToken: 160 * 1024, context: 32768, capabilities: ["general", "code", "reasoning"], useCase: "Near-flagship quality that still fits 32GB.", tier: "large" },

  /* ── Mixture-of-experts ─────────────────────────────────────────────────
     Sparse models: memory is set by the total parameter count, speed by the
     handful of experts each token actually routes through. They are the only
     way a 24GB machine runs anything in this weight class at a usable rate, so
     `activeBytes` exists to stop the speed estimate reading them as dense.     */
  { tag: "gpt-oss:20b", name: "GPT-OSS 20B", family: "OpenAI", params: 20.9e9, bytes: 13 * GB, activeBytes: 4.2 * GB, kvPerToken: 48 * 1024, context: 131072, capabilities: ["code", "reasoning", "general"], useCase: "Agentic coding and reasoning at 4x the speed of a dense model its size.", tier: "large", flagship: true },

  /* ── Llama ──────────────────────────────────────────────────────────── */
  { tag: "llama3.2:1b", name: "Llama 3.2 1B", family: "Llama", params: 1.2e9, bytes: 1.3 * GB, kvPerToken: 32 * 1024, context: 131072, capabilities: ["general"], useCase: "Smallest usable assistant; summarising and routing.", tier: "tiny" },
  { tag: "llama3.2:3b", name: "Llama 3.2 3B", family: "Llama", params: 3.2e9, bytes: 2.0 * GB, kvPerToken: 56 * 1024, context: 131072, capabilities: ["general"], useCase: "Snappy everyday helper with a tiny footprint; chats well, but does not write code or drive tools reliably.", tier: "small" },
  { tag: "llama3.1:8b", name: "Llama 3.1 8B", family: "Llama", params: 8e9, bytes: 4.9 * GB, kvPerToken: 128 * 1024, context: 131072, capabilities: ["general", "code"], useCase: "Well-rounded general model with long context.", tier: "small" },
  { tag: "llama3.3:70b", name: "Llama 3.3 70B", family: "Llama", params: 70.6e9, bytes: 43 * GB, kvPerToken: 320 * 1024, context: 131072, capabilities: ["general", "reasoning", "code"], useCase: "Workstation-class quality; needs 64GB or more.", tier: "xlarge" },

  /* ── Gemma ──────────────────────────────────────────────────────────── */
  { tag: "gemma3:1b", name: "Gemma 3 1B", family: "Google", params: 1e9, bytes: 0.8 * GB, kvPerToken: 32 * 1024, context: 32768, capabilities: ["general"], useCase: "Very small general model.", tier: "tiny" },
  { tag: "gemma3:4b", name: "Gemma 3 4B", family: "Google", params: 4.3e9, bytes: 3.3 * GB, kvPerToken: 88 * 1024, context: 131072, capabilities: ["general", "vision"], useCase: "Small multimodal model that reads screenshots.", tier: "small" },
  { tag: "gemma3:12b", name: "Gemma 3 12B", family: "Google", params: 12.2e9, bytes: 8.1 * GB, kvPerToken: 160 * 1024, context: 131072, capabilities: ["general", "vision", "reasoning"], useCase: "Multimodal work with real reasoning ability.", tier: "medium" },
  { tag: "gemma3:27b", name: "Gemma 3 27B", family: "Google", params: 27.4e9, bytes: 17 * GB, kvPerToken: 224 * 1024, context: 131072, capabilities: ["general", "vision", "reasoning"], useCase: "Strongest local multimodal option.", tier: "large" },

  /* ── Phi ────────────────────────────────────────────────────────────── */
  { tag: "phi4-mini:3.8b", name: "Phi-4 Mini 3.8B", family: "Microsoft", params: 3.8e9, bytes: 2.5 * GB, kvPerToken: 64 * 1024, context: 131072, capabilities: ["general", "reasoning"], useCase: "Dense small model that punches above its size.", tier: "small" },
  { tag: "phi4:14b", name: "Phi-4 14B", family: "Microsoft", params: 14.7e9, bytes: 9.1 * GB, kvPerToken: 160 * 1024, context: 16384, capabilities: ["general", "reasoning"], useCase: "Maths and structured reasoning.", tier: "medium" },

  /* ── Dedicated code models ──────────────────────────────────────────── */
  { tag: "starcoder2:3b", name: "StarCoder2 3B", family: "BigCode", params: 3e9, bytes: 1.7 * GB, kvPerToken: 48 * 1024, context: 16384, capabilities: ["code", "autocomplete"], useCase: "Fill-in-the-middle completion.", tier: "small" },
  { tag: "starcoder2:7b", name: "StarCoder2 7B", family: "BigCode", params: 7e9, bytes: 4.0 * GB, kvPerToken: 112 * 1024, context: 16384, capabilities: ["code", "autocomplete"], useCase: "Stronger completion across many languages.", tier: "small" },
  { tag: "codellama:7b", name: "Code Llama 7B", family: "Meta", params: 7e9, bytes: 3.8 * GB, kvPerToken: 128 * 1024, context: 16384, capabilities: ["code"], useCase: "Classic code model; broad language coverage.", tier: "small" },
  { tag: "codegemma:7b", name: "CodeGemma 7B", family: "Google", params: 8.5e9, bytes: 5.0 * GB, kvPerToken: 128 * 1024, context: 8192, capabilities: ["code", "autocomplete"], useCase: "Completion tuned for real repositories.", tier: "small" },
  { tag: "granite-code:8b", name: "Granite Code 8B", family: "IBM", params: 8e9, bytes: 4.6 * GB, kvPerToken: 128 * 1024, context: 32768, capabilities: ["code"], useCase: "Enterprise code model with permissive licensing.", tier: "small" },

  /* ── Vision ─────────────────────────────────────────────────────────── */
  { tag: "moondream:1.8b", name: "Moondream 1.8B", family: "Moondream", params: 1.8e9, bytes: 1.7 * GB, kvPerToken: 40 * 1024, context: 2048, capabilities: ["vision"], useCase: "Tiny vision model for screenshot description.", tier: "tiny" },
  { tag: "qwen3-vl:2b", name: "Qwen3 VL 2B", family: "Qwen", params: 2.1e9, bytes: 1.9 * GB, kvPerToken: 48 * 1024, context: 32768, capabilities: ["vision", "general"], useCase: "Screenshot-to-code and UI cloning.", tier: "tiny" },
  { tag: "qwen3-vl:8b", name: "Qwen3 VL 8B", family: "Qwen", params: 8.3e9, bytes: 5.5 * GB, kvPerToken: 128 * 1024, context: 32768, capabilities: ["vision", "general", "code"], useCase: "Accurate design-to-code from screenshots.", tier: "small" },
  { tag: "llava:7b", name: "LLaVA 7B", family: "LLaVA", params: 7e9, bytes: 4.7 * GB, kvPerToken: 128 * 1024, context: 4096, capabilities: ["vision"], useCase: "General image understanding.", tier: "small" },

  /* ── Embeddings ─────────────────────────────────────────────────────── */
  { tag: "nomic-embed-text", name: "Nomic Embed Text", family: "Nomic", params: 0.137e9, bytes: 0.27 * GB, kvPerToken: 0, context: 8192, capabilities: ["embedding"], useCase: "Codebase indexing and semantic search.", tier: "tiny" },
  { tag: "mxbai-embed-large", name: "MxBai Embed Large", family: "MixedBread", params: 0.335e9, bytes: 0.67 * GB, kvPerToken: 0, context: 512, capabilities: ["embedding"], useCase: "Higher-quality retrieval embeddings.", tier: "tiny" },
  { tag: "embeddinggemma", name: "EmbeddingGemma", family: "Google", params: 0.3e9, bytes: 0.62 * GB, kvPerToken: 0, context: 2048, capabilities: ["embedding"], useCase: "Compact multilingual embeddings.", tier: "tiny" },
]);

/* ────────────────────────────────────────────────────────────────────────── */
/* Fit analysis                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/** Support levels, best to worst. */
export const FIT_LEVELS = Object.freeze(["recommended", "supported", "tight", "unsupported"]);

/**
 * How much memory a model actually needs at a given context length:
 * weights, plus KV cache for the context, plus runtime overhead.
 */
export function memoryRequirement(model, contextTokens) {
  const context = Math.min(contextTokens ?? PRACTICAL_CONTEXT_TOKENS, model.context);
  const kvBytes = (model.kvPerToken ?? 0) * context;
  return Math.round(model.bytes + kvBytes + RUNTIME_OVERHEAD_BYTES);
}

/**
 * Estimated decode speed in tokens per second.
 *
 * A decode step must read every weight from memory, so throughput is bounded by
 * bandwidth / model size. The efficiency factor accounts for everything that is
 * not a pure streaming read. This lands within roughly 15% of measured figures
 * on Apple Silicon, which is close enough to set expectations and is always
 * labelled as an estimate in the interface.
 *
 * A mixture-of-experts model breaks the premise: it routes each token through a
 * few of its experts and leaves the rest untouched, so the read set per token is
 * far smaller than the file. Those entries carry `activeBytes`, and it is used
 * here in place of `bytes` — memory still budgets the whole file, because every
 * expert has to be resident even though only some are read.
 */
export function estimateTokensPerSecond(model, device) {
  const gpu = device.accelerator === "apple-unified" || device.accelerator === "cuda";
  const bandwidth = device.bandwidthGBs ?? ASSUMED_CPU_BANDWIDTH;
  const efficiency = gpu ? BANDWIDTH_EFFICIENCY : CPU_BANDWIDTH_EFFICIENCY;
  const readGiB = (model.activeBytes ?? model.bytes) / GB;
  if (readGiB <= 0) return null;
  return Math.round((bandwidth / readGiB) * efficiency);
}

/**
 * Does this model fit this machine, and how comfortably?
 *
 * The thresholds are fractions of *usable* memory, not total: on Apple Silicon
 * the GPU may only wire about three quarters of RAM, and exceeding that does
 * not fail loudly — it swaps, and inference becomes unusable. Budgeting against
 * the real ceiling is what makes the badge trustworthy.
 */
export function fitFor(model, device, { contextTokens } = {}) {
  const required = memoryRequirement(model, contextTokens);
  const usable = device.usableMemoryBytes;
  const ratio = required / usable;

  let level;
  let reason;
  if (ratio <= 0.7) {
    level = "recommended";
    reason = "Fits with room for your editor and browser alongside it.";
  } else if (ratio <= 0.85) {
    level = "supported";
    reason = "Runs well, but leaves little room for other heavy apps.";
  } else if (ratio <= 1) {
    level = "tight";
    reason = "Only fits with almost nothing else running; expect stalls.";
  } else {
    level = "unsupported";
    reason = `Needs about ${(required / GB).toFixed(1)} GB but only ${(usable / GB).toFixed(1)} GB is usable on this machine.`;
  }

  const tokensPerSecond = estimateTokensPerSecond(model, device);
  return {
    level,
    reason,
    requiredBytes: required,
    usableBytes: usable,
    headroomBytes: usable - required,
    utilisation: Number(ratio.toFixed(3)),
    tokensPerSecond,
    speed: speedBand(tokensPerSecond),
  };
}

/** Coarse, honest speed label. Numbers are estimates; bands are the message. */
export function speedBand(tokensPerSecond) {
  if (tokensPerSecond === null) return "unknown";
  if (tokensPerSecond >= 45) return "instant";
  if (tokensPerSecond >= 20) return "fast";
  if (tokensPerSecond >= 10) return "steady";
  if (tokensPerSecond >= 4) return "slow";
  return "impractical";
}

/**
 * Merge the catalogue with what Ollama actually has on disk.
 *
 * Installed models that are not in the catalogue still appear — a hand-built
 * Modelfile or a Hugging Face pull is a legitimate thing to have — with their
 * requirements derived from the real on-disk size rather than dropped.
 */
export function buildLibrary(device, installed = [], { contextTokens } = {}) {
  const byTag = new Map();

  for (const entry of CATALOG) {
    byTag.set(normalise(entry.tag), { ...entry, installed: false, installedBytes: null, installedTag: null });
  }

  const canonicalToKey = new Map(CATALOG.map((entry) => [canonicalise(entry.tag), normalise(entry.tag)]));

  for (const local of installed) {
    const name = local.name ?? local.model ?? "";
    const key = catalogKeyFor(name, canonicalToKey);
    const existing = byTag.get(key);
    if (existing) {
      // Two installed tags can resolve to one catalogue row — a stock pull and a
      // purpose-built `frontier-*` Modelfile of the same weights. The custom build
      // wins: it is the one whose context window we chose.
      const pinned = pinnedContext(name);
      if (existing.installed && !isCustomBuild(name)) continue;
      existing.installed = true;
      existing.installedBytes = local.size ?? null;
      existing.installedTag = local.name;
      // A `frontier-*` build pins its window in the Modelfile; the catalogue's
      // figure is the stock model's and would overstate it.
      if (pinned) existing.context = pinned;
      // Trust the real file over the published figure.
      if (local.size) existing.bytes = local.size;
      continue;
    }
    // Not in the catalogue — describe it from what Ollama reports.
    const params = parseParams(local.details?.parameter_size);
    byTag.set(key, {
      tag: local.name,
      name: prettyName(local.name),
      family: local.details?.family ? capitalise(local.details.family) : "Local",
      params,
      bytes: local.size ?? 0,
      kvPerToken: estimateKvPerToken(params),
      context: pinnedContext(name) ?? 8192,
      capabilities: inferCapabilities(local),
      useCase: "Installed locally; not part of the shipped catalogue.",
      tier: tierFor(params),
      custom: true,
      installed: true,
      installedBytes: local.size ?? null,
      installedTag: local.name,
    });
  }

  return Array.from(byTag.values()).map((model) => ({
    ...model,
    fit: fitFor(model, device, { contextTokens }),
  }));
}

/** Ollama's implicit `:latest` carries no meaning; drop it. */
function normalise(tag) {
  return String(tag).replace(/:latest$/, "");
}

/**
 * A tag reduced to letters and digits, so that the three ways the same model is
 * written — `qwen2.5-coder:14b`, `qwen2.5-coder:14b-instruct` and the custom
 * build `frontier-qwen2.5-coder-14b-8k` — all land on one key.
 */
function canonicalise(tag) {
  return String(tag).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A Modelfile we built ourselves, named `frontier-<base>-<size>-<context>`. */
function isCustomBuild(tag) {
  return /^frontier-/i.test(normalise(tag));
}

/**
 * The context window a `frontier-*` build pins in its Modelfile, read off the
 * `-8k` / `-32k` suffix that names it. Null for anything else.
 */
function pinnedContext(tag) {
  if (!isCustomBuild(tag)) return null;
  const match = /-(\d+)k$/i.exec(normalise(tag));
  return match ? Number(match[1]) * 1024 : null;
}

/**
 * Which catalogue row an installed tag belongs to.
 *
 * Ollama tags carry decoration the catalogue does not: an `-instruct` or
 * quantisation suffix on a stock pull, and the `frontier-<base>-<size>-<ctx>`
 * shape of our own builds. Matching only on the exact string dropped every one
 * of those into the unknown-model branch, which cost them their real capability
 * data and so their place in the routing lanes. Anything that still matches
 * nothing keeps its own name as the key and is described from Ollama's metadata.
 */
function catalogKeyFor(tag, canonicalToKey) {
  const plain = normalise(tag);
  if (canonicalToKey.has(canonicalise(plain))) return canonicalToKey.get(canonicalise(plain));

  // `qwen2.5-coder:14b-instruct` and `…:24b-instruct-2512-q4_K_M` → `…:14b`.
  const trimmed = plain.replace(/(:\d+(?:\.\d+)?b)[-_.].*$/i, "$1");
  if (canonicalToKey.has(canonicalise(trimmed))) return canonicalToKey.get(canonicalise(trimmed));

  // `frontier-qwen2.5-coder-14b-8k` → the `qwen2.5-coder:14b` row.
  if (isCustomBuild(plain)) {
    const base = plain.replace(/^frontier-/i, "").replace(/-\d+k$/i, "");
    if (canonicalToKey.has(canonicalise(base))) return canonicalToKey.get(canonicalise(base));
  }

  return plain;
}

function parseParams(value) {
  const match = /([\d.]+)\s*([BM])/i.exec(String(value ?? ""));
  if (!match) return 0;
  const n = Number(match[1]);
  return match[2].toUpperCase() === "B" ? n * 1e9 : n * 1e6;
}

/** Rough KV cost for a model we have no architecture data for. */
function estimateKvPerToken(params) {
  if (!params) return 128 * 1024;
  const billions = params / 1e9;
  if (billions <= 2) return 40 * 1024;
  if (billions <= 4) return 64 * 1024;
  if (billions <= 9) return 128 * 1024;
  if (billions <= 16) return 192 * 1024;
  if (billions <= 30) return 224 * 1024;
  return 320 * 1024;
}

function tierFor(params) {
  const billions = params / 1e9;
  if (billions <= 2) return "tiny";
  if (billions <= 9) return "small";
  if (billions <= 16) return "medium";
  if (billions <= 40) return "large";
  return "xlarge";
}

function inferCapabilities(local) {
  const families = (local.details?.families ?? []).join(" ").toLowerCase();
  const name = String(local.name ?? "").toLowerCase();
  const capabilities = [];
  if (families.includes("clip") || /vl|vision|llava|moondream/.test(name)) capabilities.push("vision");
  if (/coder|code|devstral|starcoder/.test(name)) capabilities.push("code");
  if (/r1|reason|think|qwen3\.8/.test(name)) capabilities.push("reasoning");
  if (/embed/.test(name)) capabilities.push("embedding");
  if (capabilities.length === 0) capabilities.push("general");
  return capabilities;
}

function prettyName(tag) {
  const base = String(tag).split("/").pop() ?? tag;
  return base.replace(/:latest$/, "").replace(/[-:]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function capitalise(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Routing                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const USABLE_LEVELS = new Set(["recommended", "supported"]);

/**
 * Choose the models Frontier Auto and Frontier Flash will actually run.
 *
 * Flash is the lightest installed model that can still write code — speed is
 * the whole point of that lane, so a model that is merely *capable* but slow is
 * the wrong answer. Auto's heavy lane is the strongest installed model that
 * still fits comfortably; a model rated `tight` is deliberately never chosen
 * automatically, because a swapping machine is worse than a smaller answer.
 */
export function planRouting(library) {
  const usable = library.filter((model) => model.installed && USABLE_LEVELS.has(model.fit.level));

  // A model whose first capability is vision or embedding is built for that job
  // and is a poor general assistant, however small it happens to be. Size alone
  // is the wrong way to pick a lane.
  const isSpecialist = (model) =>
    model.capabilities[0] === "vision" || model.capabilities.includes("embedding");
  const writesCode = (model) => model.capabilities.includes("code");
  const isGeneral = (model) => model.capabilities.includes("general") || model.capabilities.includes("reasoning");

  const candidates = usable.filter((model) => !isSpecialist(model) && (writesCode(model) || isGeneral(model)));

  // Prefer a model that can actually write code for the everyday lane; only
  // fall back to a general model when nothing else is installed.
  const coders = candidates.filter(writesCode).sort((a, b) => a.bytes - b.bytes);
  const generals = [...candidates].sort((a, b) => a.bytes - b.bytes);
  const light = coders[0] ?? generals[0] ?? null;

  // Strongest that still fits comfortably, preferring a coding model over a
  // general one at equal weight.
  //
  // Strength is parameter count, not file size. Quantisation moves bytes without
  // moving what a model knows — a 27B at IQ3_M is smaller on disk than a 24B at
  // Q4_K_M — and a mixture-of-experts model reads a fraction of its file per
  // token, so ranking by bytes puts a dense 24B above a sparse 21B that answers
  // four times faster.
  //
  // Speed is a floor rather than a ranking term: the heavy lane is where the
  // slow models live by design, but a model too slow to sit through is not the
  // stronger choice however many parameters it has. If nothing clears the bar,
  // the lane collapses onto `light`, which is the honest answer — this machine
  // has no model that is both stronger and usable.
  const fastEnough = (model) => (model.fit.tokensPerSecond ?? 0) >= MIN_HEAVY_TOKENS_PER_SECOND;
  const heavyPool = [...(coders.length ? coders : candidates)].filter(fastEnough).sort((a, b) => {
    const codeDelta = Number(b.capabilities.includes("code")) - Number(a.capabilities.includes("code"));
    if (codeDelta !== 0 && Math.abs(strengthOf(a) - strengthOf(b)) < 2e9) return codeDelta;
    return strengthOf(b) - strengthOf(a);
  });
  const heavy = heavyPool[0] ?? light;

  // Smallest capable vision model — screenshot work does not need a big one.
  const vision =
    usable.filter((model) => model.capabilities.includes("vision")).sort((a, b) => a.bytes - b.bytes)[0] ?? null;
  const embedding = usable.find((model) => model.capabilities.includes("embedding")) ?? null;

  return {
    light: light ? summarise(light) : null,
    heavy: heavy ? summarise(heavy) : null,
    vision: vision ? summarise(vision) : null,
    embedding: embedding ? summarise(embedding) : null,
    candidateCount: candidates.length,
    /** Nothing installed fits — the caller must say so rather than pretend. */
    degraded: candidates.length === 0,
  };
}

function summarise(model) {
  return {
    tag: model.installedTag ?? model.tag,
    name: model.name,
    bytes: model.bytes,
    params: model.params,
    tier: model.tier,
    capabilities: model.capabilities,
    fit: model.fit,
  };
}

/**
 * Which lane a prompt belongs in.
 *
 * Mirrors the existing complexity signals in gateway/frontier-runner.js so the
 * two never disagree about what "heavy" means.
 */
export function laneForPrompt(prompt, mode = "auto") {
  if (mode === "flash") return { lane: "light", reason: "flash_always_light", complexity: 0 };
  if (mode === "max") return { lane: "heavy", reason: "max_always_heavy", complexity: 0 };

  const text = String(prompt ?? "").toLowerCase();
  const signals = [
    /\b(multi[- ]?file|repository[- ]?wide|cross[- ]?cutting)\b/,
    /\b(refactor|architecture|migration|concurrency|parallel|race|deadlock)\b/,
    /\b(debug|diagnos|root cause|benchmark|performance|security|authentication)\b/,
    /\b(design|implement|build)\b[\s\S]{0,80}\b(system|feature|workflow|integration)\b/,
  ];
  const complexity =
    signals.reduce((score, pattern) => score + Number(pattern.test(text)), 0) + Number(text.length >= 600);

  return complexity >= 2
    ? { lane: "heavy", reason: "auto_complex_task", complexity }
    : { lane: "light", reason: "auto_light_task", complexity };
}

/** Resolve a prompt and mode to the concrete model that will serve it. */
export function resolveModel(library, prompt, mode = "auto") {
  const plan = planRouting(library);
  const { lane, reason, complexity } = laneForPrompt(prompt, mode);
  const chosen = lane === "heavy" ? plan.heavy ?? plan.light : plan.light;
  return {
    lane,
    reason: plan.degraded ? "no_supported_model" : reason,
    complexity,
    model: chosen,
    plan,
  };
}
