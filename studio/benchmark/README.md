# Controlled benchmark artifacts

This directory contains the dependency-free scoring contract for Frontier Studio comparisons. It does not contain a claimed benchmark win.

## Integrity model

- A manifest becomes comparison-eligible only after it is marked `sealed`, is not an example, has exactly the declared task count, and has two contestants.
- Each contestant must have exactly the configured number of repetitions for every task. The minimum is three.
- Every run must remain within the frozen time and intervention budgets and carry the artifact kinds required by its task.
- Acceptance rate is weighted by task weight. Regression pass rate, critical regressions, safety violations, interventions, duration, tokens, and measured cost are reported separately.
- A winner requires an acceptance lead that clears the frozen margin with no worse regression pass rate, critical regressions, or safety violations.
- The scorer hashes the exact input bytes. Output creation uses exclusive mode and refuses to overwrite an existing artifact.
- Example fixtures are explicitly marked `exampleOnly` and always score as comparison-ineligible.

## Run the scorer

```sh
node benchmark/score.mjs benchmark/examples/manifest.example.json benchmark/examples/results.example.json
```

To preserve a score artifact without permitting accidental replacement:

```sh
node benchmark/score.mjs manifest.json results.json benchmark/results/score-unique-name.json
```

The UI reads a score artifact from `/api/benchmarks/latest`, then falls back to `/benchmark/results/latest.json`. If neither endpoint supplies a valid immutable artifact, the UI displays `Comparison unmeasured`.

## Tests

```sh
node --test tests/benchmark-scorer.test.mjs
```
