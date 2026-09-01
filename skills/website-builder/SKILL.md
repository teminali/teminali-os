---
name: website-builder
description: Plan, build, redesign, or optimize production websites and web applications using modern, best-in-class UI frameworks (Next.js, React, shadcn/ui, Tailwind CSS, Framer Motion) and complete layout architectures. Automatically applies the Teminali UI/UX Design System, bento grids, app shells, lighting depth, and ultra-polished aesthetics.
---

# Website & Web Application Builder

Build high-performance, visually stunning, production-grade web applications. Always adhere to full-layout architecture, holistic composition, and ultra-polished aesthetics.

## 1. UI Framework & Holistic Layout Orchestration

When building a website or user interface:
- **Default Stack**: Use **React + Next.js (App Router) + Tailwind CSS + shadcn/ui + Framer Motion + Lucide Icons** (see [ui-frameworks.md](references/ui-frameworks.md)).
- **Layout Composition**: Always structure pages using complete layout archetypes (see [layouts-and-polish.md](references/layouts-and-polish.md)):
  - **SaaS / Landing Archetype**: Announcement shimmer pill, ambient spotlight hero with gradient typography, 3D perspective mockup, asymmetrical bento grid, interactive tabbed workflow showcase, tiered pricing matrix, social proof masonry, high-conversion bottom glow CTA, and multi-column status footer.
  - **Web App / Studio Archetype**: Collapsible activity sidebar, top command bar (`⌘K`), KPI metric sparklines, resizable multi-pane split viewports, and filterable data tables.

## 2. Ultra-Polish Design Principles (Zero-Slop Standard)

All generated interfaces must strictly follow the **Teminali Design Language**:
1. **Lighting & Depth**: Multi-layer dark slate/obsidian surfaces (`bg-[#141724]/80`), backdrop blur (`backdrop-blur-md`), 1px top border highlights (`border-t border-white/15`), and ambient radial glow backdrops.
2. **Component Primitives**: Always use standard, accessible primitives (`Button`, `Card`, `Dialog`, `Tabs`, `Table`, `Input`, `Badge`, `Skeleton`) from `shadcn/ui`.
3. **Motion & Interactions**: Apply fluid entrance animations and micro-interactions with `framer-motion` (`ease: [0.16, 1, 0.3, 1]`).
4. **Complete State Handling**: Always provide loading skeletons (`Skeleton`), empty states with CTAs, and interactive hover/active states (`active:scale-[0.98]`).
5. **No Plain / Generic Blocks**: Never output unstyled HTML or isolated generic cards. Everything must be part of an integrated, polished visual experience.

## 3. Execution Workflow

1. Read [layouts-and-polish.md](references/layouts-and-polish.md) and [ui-frameworks.md](references/ui-frameworks.md).
2. Scaffold dependencies (`create-next-app` or `vite`, `shadcn init`, `framer-motion`, `lucide-react`).
3. Build the responsive layout archetype, navigation, hero, bento grids, and interactive feature components.
4. Verify responsive behavior across mobile and desktop widths and ensure zero console/type errors.
