# Build planner repair

Repair the implementation under `src/` without changing tests or this specification.

`createBuildPlan(graph, changed, cache)` must:

1. Accept a plain object whose own enumerable keys are package names and whose values are arrays of dependency package names.
2. Reject malformed graphs, unknown dependencies, unknown changed packages, and dependency cycles with `GraphError` carrying the stable codes `INVALID_GRAPH`, `UNKNOWN_DEPENDENCY`, `UNKNOWN_CHANGED`, and `CYCLE` respectively.
3. Never mutate `graph`, its dependency arrays, `changed`, or `cache`.
4. Select every changed package plus all direct and transitive dependents.
5. Return selected packages in deterministic topological build order: dependencies before dependents and lexical order whenever multiple packages are ready.
6. Omit a selected package when `cache` has an own property for that package whose value is exactly `true`; cached packages must not prevent their dependents from appearing.
7. Return entries shaped exactly as `{ name, reason }`, where `reason` is `"changed"` for explicitly changed packages and `"dependent"` otherwise. Duplicate changed names must not duplicate output entries.
8. Handle package names such as `constructor` and `__proto__` without consulting inherited properties.

No placeholders or external dependencies are permitted.
