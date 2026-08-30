import assert from "node:assert/strict";
import test from "node:test";

import { QuotaPool, QuotaUnavailableError } from "./quota-pool.js";

function groqLane(alias, quotaGroup = alias) {
  return {
    alias,
    quotaGroup,
    provider: "groq",
    limits: { rpm: 30, rpd: 1_000, tpm: 8_000, tpd: 200_000 },
  };
}

test("spreads observed-size requests across independent quota groups", () => {
  const pool = new QuotaPool({
    lanes: [groqLane("groq-a"), groqLane("groq-b"), groqLane("groq-c")],
    clock: () => 0,
  });

  const aliases = [];
  for (let index = 0; index < 3; index += 1) {
    const lease = pool.reserve({ estimatedTokens: 6_500 });
    aliases.push(lease.alias);
    lease.commit();
  }

  assert.deepEqual(aliases, ["groq-a", "groq-b", "groq-c"]);
  assert.throws(
    () => pool.reserve({ estimatedTokens: 6_500 }),
    (error) => error instanceof QuotaUnavailableError && error.retryAfterMs === 60_000,
  );
});

test("controlled mode never escapes its pinned lane", () => {
  const pool = new QuotaPool({
    lanes: [groqLane("groq-a"), groqLane("groq-b")],
    clock: () => 0,
  });

  pool.reserve({ estimatedTokens: 6_500, pinnedAlias: "groq-a" }).commit();

  assert.throws(
    () => pool.reserve({ estimatedTokens: 6_500, pinnedAlias: "groq-a" }),
    QuotaUnavailableError,
  );
  const backup = pool.reserve({ estimatedTokens: 6_500, pinnedAlias: "groq-b" });
  assert.equal(backup.alias, "groq-b");
  backup.cancel();
});

test("a pre-stream rate limit cools one lane and fails over to another", () => {
  let now = 0;
  const pool = new QuotaPool({
    lanes: [groqLane("groq-a"), groqLane("groq-b")],
    clock: () => now,
  });

  pool.reserve({ estimatedTokens: 1_000 }).rateLimited(30_000);
  const fallback = pool.reserve({ estimatedTokens: 1_000 });
  assert.equal(fallback.alias, "groq-b");
  fallback.cancel();

  assert.throws(
    () => pool.reserve({ estimatedTokens: 1_000, pinnedAlias: "groq-a" }),
    (error) => error instanceof QuotaUnavailableError && error.retryAfterMs === 30_000,
  );

  now = 30_000;
  const recovered = pool.reserve({ estimatedTokens: 1_000, pinnedAlias: "groq-a" });
  assert.equal(recovered.alias, "groq-a");
  recovered.cancel();
});

test("minute budgets reset deterministically", () => {
  let now = 0;
  const pool = new QuotaPool({
    lanes: [groqLane("groq-a")],
    clock: () => now,
  });

  pool.reserve({ estimatedTokens: 6_500 }).commit();
  assert.throws(() => pool.reserve({ estimatedTokens: 6_500 }), QuotaUnavailableError);

  now = 60_000;
  const lease = pool.reserve({ estimatedTokens: 6_500 });
  assert.equal(lease.alias, "groq-a");
  lease.cancel();
});

test("daily request budgets do not reset with the minute window", () => {
  let now = 0;
  const lane = groqLane("groq-a");
  lane.limits = { ...lane.limits, rpm: 1, rpd: 1 };
  const pool = new QuotaPool({ lanes: [lane], clock: () => now });

  pool.reserve({ estimatedTokens: 100 }).commit();
  now = 60_000;
  assert.throws(
    () => pool.reserve({ estimatedTokens: 100 }),
    (error) =>
      error instanceof QuotaUnavailableError &&
      error.retryAfterMs === 86_340_000,
  );

  now = 86_400_000;
  const lease = pool.reserve({ estimatedTokens: 100 });
  assert.equal(lease.alias, "groq-a");
  lease.cancel();
});

test("rejects duplicate organization quota groups", () => {
  assert.throws(
    () =>
      new QuotaPool({
        lanes: [groqLane("groq-key-one", "same-org"), groqLane("groq-key-two", "same-org")],
      }),
    /duplicate quota group: same-org/,
  );
});

test("rejects secrets at the quota-selection boundary", () => {
  assert.throws(
    () =>
      new QuotaPool({
        lanes: [{ ...groqLane("groq-a"), apiKey: "must-not-enter-selector" }],
      }),
    /unsupported field: apiKey/,
  );
});

test("snapshots expose aliases and counters but no credential material", () => {
  const pool = new QuotaPool({
    lanes: [groqLane("groq-a")],
    clock: () => 0,
  });
  pool.reserve({ estimatedTokens: 1_000 }).commit(750);

  assert.deepEqual(pool.snapshot(), [
    {
      alias: "groq-a",
      quotaGroup: "groq-a",
      provider: "groq",
      minuteRequests: 1,
      dayRequests: 1,
      minuteTokens: 750,
      dayTokens: 750,
      inFlight: 0,
      cooldownRemainingMs: 0,
    },
  ]);
});

test("prioritizes local lane over cloud lanes deterministically", () => {
  const localLane = {
    alias: "ollama-devstral",
    quotaGroup: "local-devstral",
    provider: "ollama",
    priority: 1,
    limits: { rpm: 60, rpd: 10_000, tpm: 100_000, tpd: 1_000_000 },
  };
  const cloudLane = {
    alias: "claude-sonnet",
    quotaGroup: "anthropic-primary",
    provider: "anthropic",
    priority: 10,
    limits: { rpm: 60, rpd: 10_000, tpm: 200_000, tpd: 2_000_000 },
  };

  const pool = new QuotaPool({
    lanes: [cloudLane, localLane],
    clock: () => 0,
  });

  // Even though cloudLane has more available TPM, localLane is selected due to priority
  const first = pool.reserve({ estimatedTokens: 1_000 });
  assert.equal(first.alias, "ollama-devstral");
  first.commit();

  // When local lane is rate-limited / cooled down, fallback to cloud lane
  pool.reserve({ estimatedTokens: 1_000 }).rateLimited(15_000);
  const second = pool.reserve({ estimatedTokens: 1_000 });
  assert.equal(second.alias, "claude-sonnet");
  second.commit();
});
