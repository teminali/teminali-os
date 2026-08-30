# Efficient Agent Workflow

Use this workflow for substantial website work or when local and cloud models are
available. A small page edit usually needs only one agent.

## Shared task state

Persist concise repository-backed state with:

- Objective and website type
- Audience and primary action
- Acceptance criteria
- Constraints and protected scope
- Completed, Active, Blocked, and Next Action
- Evidence and measured results

Update it at meaningful checkpoints, not after every tool call. A fresh session
should be able to continue without replaying the full conversation.

Use a standardized handoff packet when roles are separated:

- `SITE_BRIEF`: audience, objective, type, pages, primary action, constraints
- `CLAIMS_REGISTER`: claim status, evidence, location, unresolved owner
- `DESIGN_SYSTEM`: approved tokens, typography, layout, imagery, motion
- `TASK_STATE`: current repository-backed execution state
- `QA_REPORT`: checks run, evidence, defects, repairs, remaining gaps

Use existing project conventions for filenames when they already provide equivalent
artifacts; do not create duplicate documentation.

## Bounded roles

- **Orchestrator:** owns scope, sequencing, task state, and final integration.
- **Structure specialist:** proposes audience journey, information architecture, and
  content requirements without editing implementation files.
- **Visual specialist:** proposes or reviews the visual system and responsive
  composition using the actual brand and content.
- **Builder:** owns implementation changes in the repository.
- **Verifier:** independently checks functional, visual, accessibility, and
  performance evidence and reports concrete defects.

Combine roles for small tasks. Never add agents merely to increase agent count, and
do not allow multiple builders to modify overlapping files concurrently.

Set a run budget before delegation. A useful default is one structure pass, one
visual-system pass, one implementation owner, one independent verification pass,
and one bounded repair pass. Allow at most one cloud escalation for a classified
hard problem unless the user approves a larger budget. Skip roles whose output is
already supplied or whose cost would not change the result.

## Local-first routing

Use a capable local coding model for high-volume, reversible work such as repository
mapping, component scaffolding, routine implementation, test execution, mechanical
repairs, and repeated QA passes. Escalate to a stronger cloud model when judgment is
high-impact or evidence shows the local lane is stuck—for example ambiguous art
direction, cross-cutting architecture, or a defect that survives a bounded retry.

Keep routing explicit and observable:

1. Reserve the estimated context, output, and cost before dispatch.
2. Prefer the configured local lane for eligible work.
3. Retry or escalate only for classified failures and within a fixed attempt budget.
4. Settle accounting from validated actual usage when available.
5. Record the selected lane, elapsed time, outcome, and reason for escalation without
   logging prompts, secrets, or private content.

Do not silently switch models during a controlled benchmark.

## Fast feedback loop

1. Establish the smallest representative page or component slice.
2. Build and inspect it at mobile and desktop widths.
3. Fix structural and system-level defects before multiplying pages.
4. Reuse verified sections, tokens, and patterns through a maintained registry.
5. Run deterministic checks continuously; reserve independent visual critique for
   meaningful milestones.
6. Stop when acceptance criteria pass and evidence is recorded. Do not spend more
   model calls polishing invisible differences without user or test feedback.

## Skill-specific evaluation

Evaluate the full workflow, not only whether code compiles. A benchmark fixture
should freeze the brief, assets, starting repository, time budget, and allowed
models. Score observable dimensions such as functional correctness, responsive and
accessibility defects, visual-system consistency, content accuracy, performance,
elapsed time, cloud cost, and required human intervention. Keep hidden checks and
the oracle outside the agent workspace.
