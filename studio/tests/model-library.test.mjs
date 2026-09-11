import assert from "node:assert/strict";
import test from "node:test";

import {
  CATALOG,
  PRACTICAL_CONTEXT_TOKENS,
  buildLibrary,
  estimateTokensPerSecond,
  fitFor,
  laneForPrompt,
  memoryRequirement,
  planRouting,
  resolveModel,
  speedBand,
} from "../server/model-catalog.js";
import {
  clearProviderKey,
  describeProviders,
  maskKey,
  planHostedRouting,
  setProviderKey,
  setProviderLanes,
  validateKey,
} from "../server/providers.js";

const GB = 1024 ** 3;

/** The machine this was developed against: M4 Pro, 24GB unified. */
const M4_PRO_24 = {
  platform: "darwin", arch: "arm64", chip: "Apple M4 Pro", accelerator: "apple-unified",
  totalMemoryBytes: 24 * GB, freeMemoryBytes: 4 * GB, usableMemoryBytes: 18 * GB, bandwidthGBs: 273,
};
/** A base M-series laptop, where the fit badge has to say "no" a lot. */
const M1_AIR_8 = {
  platform: "darwin", arch: "arm64", chip: "Apple M1", accelerator: "apple-unified",
  totalMemoryBytes: 8 * GB, freeMemoryBytes: 2 * GB, usableMemoryBytes: 6 * GB, bandwidthGBs: 68,
};
/** A workstation, where almost everything fits. */
const M3_MAX_128 = {
  platform: "darwin", arch: "arm64", chip: "Apple M3 Max", accelerator: "apple-unified",
  totalMemoryBytes: 128 * GB, freeMemoryBytes: 60 * GB, usableMemoryBytes: 102 * GB, bandwidthGBs: 400,
};

const find = (tag) => CATALOG.find((model) => model.tag === tag);
const installed = (name, size, extra = {}) => ({ name, size, details: { parameter_size: "?", ...extra } });

/* ── Memory arithmetic ────────────────────────────────────────────────────── */

test("memory requirement is weights plus KV cache plus overhead", () => {
  const model = find("qwen2.5-coder:14b");
  const required = memoryRequirement(model, 16384);
  const expected = model.bytes + model.kvPerToken * 16384 + 600 * 1024 ** 2;
  assert.equal(required, Math.round(expected));
});

test("a model is budgeted at a practical context, not its advertised maximum", () => {
  // Llama 3.2 3B advertises 128k. Judging it there would charge it 7GB of KV
  // cache for a workload nobody runs, and mark a 2GB model unsupported.
  const model = find("llama3.2:3b");
  assert.equal(model.context, 131072);
  const practical = memoryRequirement(model);
  const maximal = memoryRequirement(model, 131072);
  assert.ok(practical < maximal / 2, "the practical budget must be far below the 128k one");
  assert.ok(practical < 4 * GB, `a 2GB model should need under 4GB, got ${(practical / GB).toFixed(1)}GB`);
});

test("a longer context can push a model out of its comfort zone", () => {
  const model = find("qwen2.5-coder:14b");
  const short = fitFor(model, M4_PRO_24, { contextTokens: 4096 });
  const long = fitFor(model, M4_PRO_24, { contextTokens: 32768 });
  assert.ok(long.requiredBytes > short.requiredBytes);
  assert.ok(long.utilisation > short.utilisation);
});

/* ── Fit verdicts ─────────────────────────────────────────────────────────── */

test("the same model gets different verdicts on different machines", () => {
  const model = find("qwen2.5-coder:14b");
  assert.equal(fitFor(model, M3_MAX_128).level, "recommended");
  assert.equal(fitFor(model, M4_PRO_24).level, "recommended");
  assert.equal(fitFor(model, M1_AIR_8).level, "unsupported");
});

test("a 70B model is unsupported on a laptop and recommended on a workstation", () => {
  const model = find("llama3.3:70b");
  assert.equal(fitFor(model, M4_PRO_24).level, "unsupported");
  assert.equal(fitFor(model, M3_MAX_128).level, "recommended");
});

test("an unsupported verdict states the actual shortfall", () => {
  const fit = fitFor(find("llama3.3:70b"), M1_AIR_8);
  assert.equal(fit.level, "unsupported");
  assert.match(fit.reason, /GB/);
  assert.ok(fit.headroomBytes < 0);
});

test("a tiny model is comfortable even on 8GB", () => {
  assert.equal(fitFor(find("llama3.2:1b"), M1_AIR_8).level, "recommended");
});

/* ── Speed estimates ──────────────────────────────────────────────────────── */

test("speed tracks bandwidth divided by model size", () => {
  const small = estimateTokensPerSecond(find("llama3.2:3b"), M4_PRO_24);
  const large = estimateTokensPerSecond(find("qwen2.5-coder:32b"), M4_PRO_24);
  assert.ok(small > large * 5, "a 2GB model must be far faster than a 20GB one");
  // Re-measured on an M4 Pro (273 GB/s, 100% GPU, q8_0 KV): qwen2.5-coder:14b
  // decodes at 13.9 tok/s, not the 18-22 this previously asserted. The old
  // range was what a 0.7 bandwidth efficiency predicted rather than what the
  // machine did; BANDWIDTH_EFFICIENCY now carries the three decodes it is
  // fitted to.
  const flagship = estimateTokensPerSecond(find("qwen2.5-coder:14b"), M4_PRO_24);
  assert.ok(flagship >= 11 && flagship <= 18, `expected 11-18 tok/s, got ${flagship}`);
});

test("the same model is slower on a lower-bandwidth machine", () => {
  const onPro = estimateTokensPerSecond(find("qwen2.5-coder:7b"), M4_PRO_24);
  const onAir = estimateTokensPerSecond(find("qwen2.5-coder:7b"), M1_AIR_8);
  assert.ok(onAir < onPro);
});

test("speed bands are ordered", () => {
  assert.equal(speedBand(100), "instant");
  assert.equal(speedBand(25), "fast");
  assert.equal(speedBand(12), "steady");
  assert.equal(speedBand(5), "slow");
  assert.equal(speedBand(1), "impractical");
});

/* ── Library assembly ─────────────────────────────────────────────────────── */

test("installed models are marked, and their real size wins over the published one", () => {
  const library = buildLibrary(M4_PRO_24, [installed("qwen2.5-coder:14b", 9_100_000_000)]);
  const entry = library.find((model) => model.tag === "qwen2.5-coder:14b");
  assert.equal(entry.installed, true);
  assert.equal(entry.bytes, 9_100_000_000);
});

test("a model outside the catalogue still appears rather than vanishing", () => {
  const library = buildLibrary(M4_PRO_24, [
    installed("hf.co/someone/Custom-13B-GGUF:Q4", 8_000_000_000, { parameter_size: "13B", family: "llama" }),
  ]);
  const entry = library.find((model) => model.tag.includes("Custom-13B"));
  assert.ok(entry, "a hand-pulled model must be listed");
  assert.equal(entry.custom, true);
  assert.equal(entry.installed, true);
  assert.ok(entry.fit.requiredBytes > 8_000_000_000);
});

test("a `:latest` tag matches its catalogue entry", () => {
  const library = buildLibrary(M4_PRO_24, [installed("llama3.2:3b:latest", 2_000_000_000)]);
  const matches = library.filter((model) => model.installed);
  assert.equal(matches.length, 1);
});

test("an `-instruct` tag matches its catalogue entry rather than becoming an unknown", () => {
  const library = buildLibrary(M4_PRO_24, [installed("qwen2.5-coder:14b-instruct", 8_988_112_040)]);
  const entry = library.find((model) => model.installed);
  assert.equal(entry.tag, "qwen2.5-coder:14b");
  assert.equal(entry.installedTag, "qwen2.5-coder:14b-instruct");
  assert.ok(!entry.custom, "it is a catalogue model, not a hand-pulled one");
  assert.deepEqual(entry.capabilities, ["code", "reasoning"]);
});

test("a `frontier-*` build matches its base model and keeps the window it pins", () => {
  const library = buildLibrary(M4_PRO_24, [installed("frontier-qwen2.5-coder-14b-8k:latest", 8_988_112_040)]);
  const entry = library.find((model) => model.installed);
  assert.equal(entry.tag, "qwen2.5-coder:14b");
  assert.equal(entry.installedTag, "frontier-qwen2.5-coder-14b-8k:latest");
  // The Modelfile pins 8k; the catalogue's 32768 is the stock model's window.
  assert.equal(entry.context, 8192);
});

test("a purpose-built model wins the row over a stock pull of the same weights", () => {
  const both = [
    installed("qwen2.5-coder:14b-instruct", 8_988_112_040),
    installed("frontier-qwen2.5-coder-14b-8k:latest", 8_988_112_040),
  ];
  for (const order of [both, [...both].reverse()]) {
    const entry = buildLibrary(M4_PRO_24, order).find((model) => model.installed);
    assert.equal(entry.installedTag, "frontier-qwen2.5-coder-14b-8k:latest");
  }
});

test("a `frontier-*` build of a model outside the catalogue still reports its pinned window", () => {
  const library = buildLibrary(M4_PRO_24, [
    installed("frontier-qwen3.8-27b-iq3m-32k:latest", 13_000_000_000, { parameter_size: "27B" }),
  ]);
  const entry = library.find((model) => model.installed);
  assert.equal(entry.custom, true);
  assert.equal(entry.context, 32768);
});

/* ── Lane selection ───────────────────────────────────────────────────────── */

const REALISTIC_INSTALL = [
  installed("moondream:latest", 1_738_451_197, { family: "phi2", families: ["phi2", "clip"] }),
  installed("qwen3-vl:2b", 1_889_519_687),
  installed("llama3.2:3b", 2_019_393_189),
  installed("qwen2.5-coder:14b-instruct", 8_988_112_040),
  installed("devstral-small-2:24b-instruct-2512-q4_K_M", 15_180_000_000),
];

test("the light lane picks the smallest model that can write code", () => {
  const plan = planRouting(buildLibrary(M4_PRO_24, REALISTIC_INSTALL));
  // Moondream and qwen3-vl are smaller, but both are vision specialists, and
  // llama3.2:3b is smaller still but is a general chat model — it cannot write
  // code or drive a tool fence, which is the whole job of this lane.
  assert.equal(plan.light.tag, "qwen2.5-coder:14b-instruct");
});

test("a general chat model never wins the light lane over a real coder", () => {
  const plan = planRouting(buildLibrary(M4_PRO_24, REALISTIC_INSTALL));
  assert.notEqual(plan.light.tag, "llama3.2:3b");
  assert.ok(plan.light.capabilities.includes("code"));
});

test("only when nothing installed can code does the light lane fall back to chat", () => {
  const plan = planRouting(buildLibrary(M4_PRO_24, [installed("llama3.2:3b", 2_019_393_189)]));
  assert.equal(plan.light.tag, "llama3.2:3b");
});

test("a vision model is never chosen for the code lanes", () => {
  const plan = planRouting(buildLibrary(M4_PRO_24, REALISTIC_INSTALL));
  assert.ok(!plan.light.capabilities.includes("vision") || plan.light.capabilities[0] !== "vision");
  assert.notEqual(plan.heavy.tag, "moondream:latest");
});

test("the heavy lane refuses a model that only fits tightly", () => {
  const plan = planRouting(buildLibrary(M4_PRO_24, REALISTIC_INSTALL));
  // Devstral 24B is the biggest installed model but rates `tight` on 24GB;
  // a swapping machine is worse than a smaller answer.
  assert.notEqual(plan.heavy.tag, "devstral-small-2:24b-instruct-2512-q4_K_M");
  assert.equal(plan.heavy.tag, "qwen2.5-coder:14b-instruct");
});

test("the same install on a workstation does reach for the big model", () => {
  const plan = planRouting(buildLibrary(M3_MAX_128, REALISTIC_INSTALL));
  assert.equal(plan.heavy.tag, "devstral-small-2:24b-instruct-2512-q4_K_M");
});

test("a machine with nothing usable reports a degraded plan instead of guessing", () => {
  const plan = planRouting(buildLibrary(M1_AIR_8, [installed("llama3.3:70b", 43_000_000_000)]));
  assert.equal(plan.degraded, true);
  assert.equal(plan.light, null);
});

test("the vision lane picks the smallest vision model", () => {
  const plan = planRouting(buildLibrary(M4_PRO_24, REALISTIC_INSTALL));
  assert.equal(plan.vision.tag, "moondream:latest");
});

/* ── Prompt routing ───────────────────────────────────────────────────────── */

test("a simple request stays in the light lane", () => {
  assert.equal(laneForPrompt("fix this typo").lane, "light");
  assert.equal(laneForPrompt("what does this function do?").lane, "light");
});

test("a hard request escalates to the heavy lane", () => {
  const result = laneForPrompt("refactor the authentication architecture across the repository and debug the race condition");
  assert.equal(result.lane, "heavy");
  assert.ok(result.complexity >= 2);
});

test("explicit modes override the complexity signal", () => {
  const hard = "refactor the architecture and debug the deadlock across the whole repository";
  assert.equal(laneForPrompt(hard, "flash").lane, "light");
  assert.equal(laneForPrompt("hi", "max").lane, "heavy");
});

test("resolve returns the concrete model for the lane", () => {
  const library = buildLibrary(M4_PRO_24, REALISTIC_INSTALL);
  assert.equal(resolveModel(library, "fix a typo", "auto").model.tag, "qwen2.5-coder:14b-instruct");
  assert.equal(
    resolveModel(library, "refactor the architecture and debug the concurrency race", "auto").model.tag,
    "qwen2.5-coder:14b-instruct",
  );
});

/* ── Hosted providers ─────────────────────────────────────────────────────── */

test("a key is masked and never returned whole", () => {
  const masked = maskKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  assert.ok(!masked.includes("abcdefghij"));
  assert.match(masked, /^sk-ant-…/);
});

test("an implausible key is rejected before it is stored", () => {
  assert.equal(validateKey("anthropic", "").ok, false);
  assert.equal(validateKey("anthropic", "short").ok, false);
  assert.equal(validateKey("anthropic", "sk-proj-not-an-anthropic-key-here").ok, false);
  assert.equal(validateKey("anthropic", "sk-ant-api03-0123456789abcdefghij").ok, true);
});

test("stored keys are reported as configured but never echoed back", () => {
  const store = setProviderKey({ providers: {} }, "anthropic", "sk-ant-api03-0123456789abcdefghij");
  const [anthropic] = describeProviders(store, {}).filter((provider) => provider.id === "anthropic");
  assert.equal(anthropic.configured, true);
  assert.equal(anthropic.source, "stored");
  assert.ok(!JSON.stringify(anthropic).includes("0123456789abcdefghij"));
});

test("an environment variable counts as configured", () => {
  const described = describeProviders({ providers: {} }, { ANTHROPIC_API_KEY: "sk-ant-api03-0123456789abcdefghij" });
  const anthropic = described.find((provider) => provider.id === "anthropic");
  assert.equal(anthropic.configured, true);
  assert.equal(anthropic.source, "environment");
});

test("clearing a key disables the provider", () => {
  let store = setProviderKey({ providers: {} }, "anthropic", "sk-ant-api03-0123456789abcdefghij");
  store = clearProviderKey(store, "anthropic");
  const anthropic = describeProviders(store, {}).find((provider) => provider.id === "anthropic");
  assert.equal(anthropic.configured, false);
  assert.equal(anthropic.enabled, false);
});

test("hosted lanes default to Haiku and Sonnet, and never the flagship", () => {
  const store = setProviderKey({ providers: {} }, "anthropic", "sk-ant-api03-0123456789abcdefghij");
  const plan = planHostedRouting(describeProviders(store, {}));
  assert.match(plan.light.model, /haiku/i);
  assert.match(plan.heavy.model, /sonnet/i);
  assert.match(plan.flagshipExcluded.model, /opus/i);
  assert.notEqual(plan.heavy.model, plan.flagshipExcluded.model);
});

test("the flagship is never what Auto reaches for on any provider", () => {
  for (const id of ["anthropic", "openai", "google"]) {
    const store = setProviderKey({ providers: {} }, id, "x".repeat(40).replace(/^/, prefixFor(id)));
    const described = describeProviders(store, {});
    const plan = planHostedRouting(described, { preferred: id });
    if (plan.degraded) continue;
    assert.notEqual(plan.light.model, plan.flagshipExcluded.model, `${id} light lane`);
    assert.notEqual(plan.heavy.model, plan.flagshipExcluded.model, `${id} heavy lane`);
  }
});

function prefixFor(id) {
  return id === "anthropic" ? "sk-ant-" : id === "openai" ? "sk-" : "AI";
}

test("lane model ids can be overridden without touching code", () => {
  let store = setProviderKey({ providers: {} }, "anthropic", "sk-ant-api03-0123456789abcdefghij");
  store = setProviderLanes(store, "anthropic", { lightModel: "claude-haiku-9", heavyModel: "claude-sonnet-9" });
  const plan = planHostedRouting(describeProviders(store, {}));
  assert.equal(plan.light.model, "claude-haiku-9");
  assert.equal(plan.heavy.model, "claude-sonnet-9");
});

test("no providers configured is reported, not papered over", () => {
  const plan = planHostedRouting(describeProviders({ providers: {} }, {}));
  assert.equal(plan.degraded, true);
  assert.equal(plan.light, null);
});

/* ── What would fill an empty lane ────────────────────────────────────────
   The pane used to say "nothing installed for this lane" and stop there,
   which names a problem and leaves the user to find the fix among thirty
   models. The answer has to come from the same chooser that will later route
   to it — the moment the two disagree, the app recommends a model it would
   then decline to use, and nothing reports that.
   ──────────────────────────────────────────────────────────────────────── */

test("an empty machine is told what would take each lane, by the rules that would route to it", () => {
  const library = buildLibrary(M4_PRO_24, []);
  const plan = planRouting(library);
  assert.equal(plan.light, null, "a machine with nothing installed has no light lane");

  const fillable = planRouting(library, { installed: false });
  assert.ok(fillable.light, "nothing was offered for an empty light lane");
  // It has to be something this machine does not already have, or the offer is
  // to download what is already on disk.
  assert.equal(library.find((model) => model.tag === fillable.light.tag).installed, false);
  // The same rule the installed pass applies: the everyday lane wants a model
  // that can actually write code, not merely the smallest thing that fits.
  assert.ok(fillable.light.capabilities.includes("code"));
});

test("a suggestion is never a model this machine cannot run", () => {
  // 8 GB: most of the catalogue is out of reach, and the wrong answer here is
  // recommending a download that would swap the machine once it landed.
  const fillable = planRouting(buildLibrary(M1_AIR_8, []), { installed: false });
  for (const lane of [fillable.light, fillable.heavy, fillable.vision]) {
    if (!lane) continue;
    assert.ok(
      ["recommended", "supported"].includes(lane.fit.level),
      `${lane.tag} was offered to an 8 GB machine at fit level ${lane.fit.level}`,
    );
  }
});

test("the installed pass is unchanged by the option it gained", () => {
  const library = buildLibrary(M4_PRO_24, REALISTIC_INSTALL);
  assert.deepEqual(planRouting(library), planRouting(library, { installed: true }));
});
