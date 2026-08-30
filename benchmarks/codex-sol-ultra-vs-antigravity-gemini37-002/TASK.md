# Deterministic keyed delivery dispatcher repair

Repair the dispatcher implementation in this repository. You may modify only:

- `src/idempotency-registry.js`
- `src/keyed-queue.js`
- `src/reliable-dispatcher.js`

Keep all exported class and method names unchanged. Do not modify
`package.json`, `src/errors.js`, `src/index.js`, any file under `test/`, or
`TASK.md`. Do not add dependencies or use wall-clock timers.

`ReliableDispatcher.submit(event)` must satisfy this contract:

1. `event` has non-empty string `id` and `key` fields. Invalid events throw a
   `TypeError` synchronously before delivery.
2. `deliver(event, attempt)` receives attempt `1` first. `maxAttempts` is the
   total number of delivery calls, including the initial call.
3. Concurrent submissions with the same `event.id` share one operation. After
   it succeeds, later submissions with that id replay the fulfilled result
   without another delivery.
4. A terminally failed id is not retained. A later submission with that id may
   start a new operation.
5. Events sharing a `key` execute in submission order. A retrying event remains
   at the head of its key; later events with that key cannot overtake it.
6. Different keys may make progress concurrently, up to `maxConcurrent` active
   `deliver` invocations. Queued work and retry backoff do not occupy a delivery
   slot.
7. Retry only errors whose `retryable` property is exactly `true`, and only
   while another attempt remains. Reject with the delivery error when it is
   non-retryable or attempts are exhausted.
8. Before a retry, await `scheduler.sleep(delay)`. Use a finite non-negative
   `error.retryAfterMs` when supplied; otherwise use
   `baseDelayMs * 2 ** (attempt - 1)` after the failed attempt.
9. Completion must leave no stale retry sleeps or extra delivery calls.

Preserve the existing constructor validation and keep the implementation
dependency-free. Run `npm test`. Do not commit. In the final response, report
only the changed files and verification result.
