# Evaluator correction 001

The first post-run score was discarded because two oracle checks encoded
implementation details that were not required by `TASK.md`:

- The form gate required the exact honeypot ID `lead-hp` and CSS class
  `hp-field`. It now accepts any `tabindex="-1"` honeypot inside an
  `aria-hidden="true"` wrapper that is visually hidden by an attribute, inline
  style, or an equivalent CSS rule.
- The responsive-token gate required the exact custom property
  `--font-family`. It now accepts any `--font-*` typography token, alongside the
  already-required color, spacing, and radius tokens.

The form harness was also generalized to follow common email, error, status,
and honeypot selectors, and a spam submission is considered blocked when it
produces no success status; resetting a suspected bot form is allowed.

Neither contestant workspace was changed. Both outputs were rescored with the
same corrected oracle. Regression evidence after the correction:

- untouched seed: 20/100
- independent complete reference: 100/100
- Codex contestant: 100/100
- unchanged Frontier Code seed after its pre-dispatch failure: 20/100

The original invalid score artifacts remain archived with the suffix
`v1-invalid` in the benchmark result directory.
