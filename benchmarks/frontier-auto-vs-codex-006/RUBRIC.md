# Rubric

Eligibility is determined before scoring. Any changed file outside `src/**/*.js`, symlink, runtime mismatch, incomplete contestant identity, missing closed clock, or runtime above 45 minutes makes the run ineligible.

Eligible solutions are scored out of 100 by a controller-owned evaluator that is not copied into contestant workspaces. It covers input/domain correctness, capacity accounting, idempotency and conflicts, durable reconstruction, ledger recovery/corruption behavior, and state isolation. Visible tests are diagnostic; the private score is authoritative. A fixture reference must score 100/100 before freeze.

No network access, provider credentials, package installation, contestant communication, or cross-contestant artifact reuse is allowed.
