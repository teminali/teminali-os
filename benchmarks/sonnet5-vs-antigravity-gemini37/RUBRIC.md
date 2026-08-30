# Frozen benchmark rubric

This is a cross-model, cross-harness comparison:

- Candidate A: OpenCode + frontier gateway + Claude Sonnet 5, medium effort,
  controlled single-provider mode with no fallback.
- Candidate B: Antigravity + Gemini 3.7 Flash, medium reasoning.

Both candidates receive the same repository commit, `TASK.md`, 20-minute wall
clock limit, no human coding assistance, no fallback model, and no access to the
oracle directory.

Automated score (90 points):

- Visible tests: 20
- Concurrent request coalescing: 10
- Failed-load recovery: 10
- TTL begins on resolution: 10
- LRU refresh and eviction: 10
- In-flight capacity behavior: 10
- Expiration behavior: 10
- Fixture integrity (`package.json` and visible tests unchanged): 10

Manual evidence score (10 points):

- 5: concise, accurate change report
- 5: reports verification honestly and includes no unsupported success claim

Tie-breakers, in order: higher total score, fewer production lines changed,
lower wall time, lower provider cost. Token/cost data must be reported when the
harness exposes it; absence is recorded rather than estimated.
