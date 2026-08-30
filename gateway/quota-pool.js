const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export class QuotaUnavailableError extends Error {
  constructor(retryAfterMs) {
    super("No quota lane can accept the request");
    this.name = "QuotaUnavailableError";
    this.status = 429;
    this.retryAfterMs = retryAfterMs;
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function normalizeLimit(value, name) {
  if (value === Infinity) return value;
  return requirePositiveInteger(value, name);
}

export class QuotaPool {
  #clock;
  #lanes;
  #states;

  constructor({ lanes, clock = Date.now }) {
    if (!Array.isArray(lanes) || lanes.length === 0) {
      throw new TypeError("lanes must contain at least one quota lane");
    }
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function");
    }

    const aliases = new Set();
    const quotaGroups = new Set();
    this.#clock = clock;
    this.#lanes = lanes.map((lane) => {
      const allowed = new Set(["alias", "quotaGroup", "provider", "limits"]);
      for (const key of Object.keys(lane)) {
        if (!allowed.has(key)) {
          throw new TypeError(`quota lane contains unsupported field: ${key}`);
        }
      }

      if (typeof lane.alias !== "string" || lane.alias.length === 0) {
        throw new TypeError("lane alias must be a non-empty string");
      }
      if (typeof lane.quotaGroup !== "string" || lane.quotaGroup.length === 0) {
        throw new TypeError("lane quotaGroup must be a non-empty string");
      }
      if (aliases.has(lane.alias)) {
        throw new TypeError(`duplicate lane alias: ${lane.alias}`);
      }
      if (quotaGroups.has(lane.quotaGroup)) {
        throw new TypeError(`duplicate quota group: ${lane.quotaGroup}`);
      }
      aliases.add(lane.alias);
      quotaGroups.add(lane.quotaGroup);

      const limits = lane.limits ?? {};
      return Object.freeze({
        alias: lane.alias,
        quotaGroup: lane.quotaGroup,
        provider: lane.provider ?? "unknown",
        limits: Object.freeze({
          rpm: normalizeLimit(limits.rpm, `${lane.alias}.limits.rpm`),
          tpm: normalizeLimit(limits.tpm, `${lane.alias}.limits.tpm`),
          tpd: normalizeLimit(limits.tpd ?? Infinity, `${lane.alias}.limits.tpd`),
        }),
      });
    });

    const now = this.#clock();
    this.#states = new Map(
      this.#lanes.map((lane) => [
        lane.alias,
        {
          minuteStartedAt: now,
          dayStartedAt: now,
          minuteRequests: 0,
          minuteTokens: 0,
          dayTokens: 0,
          inFlight: 0,
          cooldownUntil: 0,
        },
      ]),
    );
  }

  reserve({ estimatedTokens, pinnedAlias } = {}) {
    requirePositiveInteger(estimatedTokens, "estimatedTokens");
    const now = this.#clock();
    this.#refresh(now);

    const candidates = this.#lanes
      .filter((lane) => pinnedAlias === undefined || lane.alias === pinnedAlias)
      .filter((lane) => this.#canAccept(lane, estimatedTokens, now))
      .sort((left, right) => this.#compare(left, right));

    if (pinnedAlias !== undefined && !this.#states.has(pinnedAlias)) {
      throw new TypeError(`unknown pinned lane: ${pinnedAlias}`);
    }
    if (candidates.length === 0) {
      throw new QuotaUnavailableError(
        this.#earliestRetryAfter(estimatedTokens, pinnedAlias, now),
      );
    }

    const lane = candidates[0];
    const state = this.#states.get(lane.alias);
    state.minuteRequests += 1;
    state.minuteTokens += estimatedTokens;
    state.dayTokens += estimatedTokens;
    state.inFlight += 1;

    let settled = false;
    const settle = (kind, value = estimatedTokens) => {
      if (settled) throw new Error("quota lease is already settled");
      settled = true;
      state.inFlight -= 1;

      if (kind === "commit") {
        requirePositiveInteger(value, "actualTokens");
        const adjustment = value - estimatedTokens;
        state.minuteTokens = Math.max(0, state.minuteTokens + adjustment);
        state.dayTokens = Math.max(0, state.dayTokens + adjustment);
        return;
      }

      state.minuteRequests = Math.max(0, state.minuteRequests - 1);
      state.minuteTokens = Math.max(0, state.minuteTokens - estimatedTokens);
      state.dayTokens = Math.max(0, state.dayTokens - estimatedTokens);
      if (kind === "rate-limit") {
        requirePositiveInteger(value, "retryAfterMs");
        state.cooldownUntil = Math.max(state.cooldownUntil, this.#clock() + value);
      }
    };

    return Object.freeze({
      alias: lane.alias,
      quotaGroup: lane.quotaGroup,
      provider: lane.provider,
      commit(actualTokens = estimatedTokens) {
        settle("commit", actualTokens);
      },
      cancel() {
        settle("cancel");
      },
      rateLimited(retryAfterMs) {
        settle("rate-limit", retryAfterMs);
      },
    });
  }

  snapshot() {
    const now = this.#clock();
    this.#refresh(now);
    return this.#lanes.map((lane) => {
      const state = this.#states.get(lane.alias);
      return Object.freeze({
        alias: lane.alias,
        quotaGroup: lane.quotaGroup,
        provider: lane.provider,
        minuteRequests: state.minuteRequests,
        minuteTokens: state.minuteTokens,
        dayTokens: state.dayTokens,
        inFlight: state.inFlight,
        cooldownRemainingMs: Math.max(0, state.cooldownUntil - now),
      });
    });
  }

  #refresh(now) {
    for (const state of this.#states.values()) {
      if (now - state.minuteStartedAt >= MINUTE_MS) {
        state.minuteStartedAt = now;
        state.minuteRequests = 0;
        state.minuteTokens = 0;
      }
      if (now - state.dayStartedAt >= DAY_MS) {
        state.dayStartedAt = now;
        state.dayTokens = 0;
      }
    }
  }

  #canAccept(lane, tokens, now) {
    const state = this.#states.get(lane.alias);
    return (
      state.cooldownUntil <= now &&
      state.minuteRequests + 1 <= lane.limits.rpm &&
      state.minuteTokens + tokens <= lane.limits.tpm &&
      state.dayTokens + tokens <= lane.limits.tpd
    );
  }

  #compare(left, right) {
    const leftState = this.#states.get(left.alias);
    const rightState = this.#states.get(right.alias);
    const leftRemaining = (left.limits.tpm - leftState.minuteTokens) / left.limits.tpm;
    const rightRemaining =
      (right.limits.tpm - rightState.minuteTokens) / right.limits.tpm;
    return (
      rightRemaining - leftRemaining ||
      leftState.inFlight - rightState.inFlight ||
      left.alias.localeCompare(right.alias)
    );
  }

  #earliestRetryAfter(tokens, pinnedAlias, now) {
    const lanes = this.#lanes.filter(
      (lane) => pinnedAlias === undefined || lane.alias === pinnedAlias,
    );
    if (lanes.length === 0) return 0;

    return Math.max(
      1,
      Math.min(
        ...lanes.map((lane) => {
          const state = this.#states.get(lane.alias);
          let readyAt = Math.max(now, state.cooldownUntil);
          if (
            state.minuteRequests + 1 > lane.limits.rpm ||
            state.minuteTokens + tokens > lane.limits.tpm
          ) {
            readyAt = Math.max(readyAt, state.minuteStartedAt + MINUTE_MS);
          }
          if (state.dayTokens + tokens > lane.limits.tpd) {
            readyAt = Math.max(readyAt, state.dayStartedAt + DAY_MS);
          }
          return readyAt - now;
        }),
      ),
    );
  }
}
