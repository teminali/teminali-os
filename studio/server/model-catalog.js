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

/** Fraction of a decode step that is memory-bandwidth bound, on a GPU backend. */
const BANDWIDTH_EFFICIENCY = 0.7;
/** CPU-only inference achieves far less of theoretical bandwidth. */
const CPU_BANDWIDTH_EFFICIENCY = 0.25;
/** Assumed DDR bandwidth when the host has no known accelerator, GB/s. */
const ASSUMED_CPU_BANDWIDTH = 50;

/**
 * KV cache cost per token, in bytes, at fp16.
 *   2 (K and V) x layers x kv_heads x head_dim x 2 bytes
 * Stored per entry because grouped-query attention makes it impossible to infer
 * from parameter count alone — an 8B model with 8 KV heads and a 14B model with
 * 8 KV heads cost almost the same per token.
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

  /* ── Llama ──────────────────────────────────────────────────────────── */
  { tag: "llama3.2:1b", name: "Llama 3.2 1B", family: "Llama", params: 1.2e9, bytes: 1.3 * GB, kvPerToken: 32 * 1024, context: 131072, capabilities: ["general"], useCase: "Smallest usable assistant; summarising and routing.", tier: "tiny" },
  { tag: "llama3.2:3b", name: "Llama 3.2 3B", family: "Llama", params: 3.2e9, bytes: 2.0 * GB, kvPerToken: 56 * 1024, context: 131072, capabilities: ["general", "code"], useCase: "Snappy everyday helper with a tiny footprint.", tier: "small" },
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
 */
export function estimateTokensPerSecond(model, device) {
  const gpu = device.accelerator === "apple-unified" || device.accelerator === "cuda";
  const bandwidth = device.bandwidthGBs ?? ASSUMED_CPU_BANDWIDTH;
  const efficiency = gpu ? BANDWIDTH_EFFICIENCY : CPU_BANDWIDTH_EFFICIENCY;
  const modelGiB = model.bytes / GB;
  if (modelGiB <= 0) return null;
  return Math.round((bandwidth / modelGiB) * efficiency);
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
  const normalise = (tag) => String(tag).replace(/:latest$/, "");

  for (const entry of CATALOG) {
    byTag.set(normalise(entry.tag), { ...entry, installed: false, installedBytes: null, installedTag: null });
  }

  for (const local of installed) {
    const key = normalise(local.name ?? local.model ?? "");
    const existing = byTag.get(key);
    if (existing) {
      existing.installed = true;
      existing.installedBytes = local.size ?? null;
      existing.installedTag = local.name;
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
      context: 8192,
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

  // Heaviest that still fits comfortably, preferring a coding model over a
  // general one at equal weight.
  const heavyPool = [...(coders.length ? coders : candidates)].sort((a, b) => {
    const codeDelta = Number(b.capabilities.includes("code")) - Number(a.capabilities.includes("code"));
    if (codeDelta !== 0 && Math.abs(a.bytes - b.bytes) < 2 * GB) return codeDelta;
    return b.bytes - a.bytes;
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
