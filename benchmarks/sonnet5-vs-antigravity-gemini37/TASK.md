# Async memoization cache repair

Fix `src/async-memo-cache.js`. Keep the public class and method names unchanged,
and do not modify `package.json` or any test file.

Acceptance criteria:

1. `getOrLoad(key, loader)` returns a cached value while it remains fresh.
2. Concurrent calls for the same missing key invoke `loader` exactly once and
   share its result.
3. A rejected loader is never cached; the next call can try again.
4. TTL begins when a loader successfully resolves, not when it starts.
5. Successful cache hits refresh LRU recency.
6. When resolved entries exceed `maxEntries`, evict the least-recently-used
   resolved entry. In-flight loads do not count toward capacity until they
   resolve and must not be evicted mid-flight.
7. Expired entries behave as misses and do not displace fresh entries.
8. Preserve the constructor validation and keep the implementation dependency-free.

Run `npm test`. Make the smallest production-code change that satisfies the
contract. Do not commit. Report the changed file and test result.
