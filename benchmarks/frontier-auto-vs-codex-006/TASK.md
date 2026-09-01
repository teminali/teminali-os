# Task: Repair the reservation ledger

Repair the multi-file CommonJS service in `src/`. It records stock reservations in an append-only JSONL ledger.

The finished service must:

- normalize SKUs and reject invalid quantities without coercion;
- prevent aggregate overselling, including after reconstruction from disk;
- make reserve and release operations idempotent by `requestId`;
- reject reuse of a request ID for a different reservation intent;
- preserve state through process/service reconstruction;
- recover from one incomplete final JSONL record while rejecting corruption elsewhere;
- return snapshots that callers cannot use to mutate internal state;
- keep the public exports and error classes compatible with the visible tests.

Run `npm test` inside your assigned workspace. You may modify or add only `src/**/*.js`. Do not use the network, install packages, read outside the assigned workspace, or alter tests/configuration. Stop when the operator calls time.
