---
name: website-builder
description: Plan, build, redesign, or optimize production websites and landing pages, including information architecture, visual direction, implementation, responsive behavior, accessibility, performance, and conversion quality. Use when the requested deliverable is a website or web page; do not use for isolated backend work or unrelated repository maintenance.
---

# Website Builder

Build a coherent, production-ready website rather than a generic template. Preserve
the user's chosen stack, existing brand, and repository conventions.

## Route the request

Before implementation, identify the website type, audience, primary action, required
pages, available content/assets, and delivery constraints. Read
[site-types.md](references/site-types.md) to select an appropriate information
architecture. If an existing project already answers these questions, proceed
without asking the user to repeat them.

For a new project with no mandated stack, prefer static output and minimal client
JavaScript for content-led landing and marketing sites. Use a full application
framework only when authenticated state, substantial server behavior, or the
existing product architecture requires it. A single simple page may not need a
framework at all. Do not replace an existing framework or design system merely to
match a preferred setup.

## Build

1. Inspect the relevant repository structure, commands, brand assets, and current
   behavior.
2. Define observable acceptance criteria covering content, interaction, responsive
   layouts, and technical constraints.
3. Establish the page hierarchy and real content flow before decorative detail.
4. Define a deliberate visual system: typography, color, spacing, grid, imagery,
   component states, and motion behavior.
5. Implement in coherent increments, reusing existing components and tokens where
   they are sound.
6. Run the project's existing build, tests, linting, and type checks. Inspect the
   result at representative mobile and desktop widths when browser tooling is
   available.
7. Read [quality-gates.md](references/quality-gates.md), fix material failures, and
   report evidence rather than unsupported quality claims.

Use [workflow.md](references/workflow.md) when the task benefits from multiple
agents, local/cloud model routing, or repository-backed recovery. Keep one owner for
integrating changes; delegate bounded analysis or verification rather than allowing
several agents to rewrite the same files.

## Product rules

- Make the primary action obvious and keep each section responsible for one job.
- Use specific, believable content. Never invent customer logos, testimonials,
  metrics, certifications, or product capabilities; mark missing facts explicitly.
- Prefer a recognizable point of view over interchangeable gradients, card grids,
  and filler copy.
- Treat mobile, keyboard access, loading, empty, error, and reduced-motion states as
  first-class behavior when applicable.
- Keep third-party packages and generated assets proportional to their value.
- Do not deploy, publish, purchase services, or change external systems unless the
  user explicitly requests it.
- Separate measured results from estimates and note any validation that could not
  be run.
