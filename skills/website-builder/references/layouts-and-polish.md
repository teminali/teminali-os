# Teminali Holistic Layout System & Ultra-Polished Aesthetics

This specification defines the complete layout composition architecture and visual polish rules that all Teminali AI agents must apply. It goes beyond simple component libraries to deliver cohesive, world-class digital experiences.

---

## 1. Core Layout Archetypes

Every generated page must use one of these structured layout archetypes. Never generate disconnected, ad-hoc blocks.

### Archetype A: The Modern SaaS / Product Landing Page
1. **Announcement Badge**: Pill with subtle shimmer border (`bg-blue-500/10 border border-blue-500/20 text-blue-400 font-mono text-xs px-3 py-1 rounded-full inline-flex items-center gap-2`).
2. **Ambient Spotlight Hero**:
   - Subtle background grid overlay + top-center radial gradient spotlight (`bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.25),rgba(255,255,255,0))]`).
   - High-impact headline with gradient text fill (`bg-clip-text text-transparent bg-gradient-to-b from-white via-slate-200 to-slate-400 font-bold tracking-tight`).
   - Magnetic dual CTA cluster: Primary glow button + Secondary glass button with video demo / icon trigger.
   - Hero Mockup / Interactive Preview container with 3D perspective tilt (`perspective-[1000px]`), glass border, and ambient floor glow.
3. **Logo / Trust Carousel**: Grayscale muted partner/technology logos with subtle opacity on hover (`opacity-40 hover:opacity-100 transition`).
4. **Asymmetric Bento Grid (Features)**:
   - 3-column / 2-row layout with cards of varying spans (`col-span-2`, `col-span-1`).
   - Each bento card contains: live mini-UI preview, micro-illustration, or interactive toggle—not just static text.
5. **Interactive Feature Showcase**:
   - Sticky scroll or tabbed switcher with animated cross-fades showcasing deep workflow steps.
6. **Tiered Pricing Matrix**:
   - Monthly / Annual toggle with savings badge (`Save 20%`).
   - Highlighted "Most Popular" card with illuminated gradient border and elevated glow.
7. **Social Proof & Testimonial Wall**: Masonry grid with user avatars, verified badges, and quote cards.
8. **High-Conversion Bottom CTA Banner**: Dark glass container with deep radial glow and instant signup input.
9. **Multi-Column Polished Footer**: Brand summary, categorized link columns, system status indicator (green pulse dot), and newsletter blur input.

---

### Archetype B: The Autonomous Studio & Web App Shell
1. **Activity Sidebar (Left)**: 56px collapsed / 240px expanded with tooltip badges and active accent pill indicator.
2. **Top Navigation & Command Bar**:
   - Breadcrumb navigation (`Workspace > Project > Dashboard`).
   - Center interactive command search (`⌘K Search or jump to...`).
   - Right cluster: Environment status badge, notifications bell with unread dot, user avatar.
3. **Multi-Pane Split Workspace**:
   - Resizable layout (`react-resizable-panels` or CSS flex split).
   - Main content viewport + collapsible contextual inspector on right.
4. **KPI Metric Strip**:
   - 4-card grid with sparkline charts, percentage deltas (`+18.4%`), and icon backdrops.
5. **Interactive Data Table / Canvas**:
   - Integrated filter chips, search input, column sort, bulk select, and row action drawer.

---

## 2. Ultra-Polish Design Principles (The "Zero-Slop" Standard)

### A. Lighting, Depth & Layering
* **No Flat Grays**: Always use nuanced slate/obsidian tones with subtle blue/purple undertones (`#08090E`, `#0D0F18`, `#141724`, `#1B2032`).
* **1px Inset Border Luminance**: Give every card and surface a sharp, semi-transparent top border (`border-t border-white/15 border-x border-white/5 border-b border-white/5`).
* **Ambient Glow Backdrops**: Place soft blur radial lights behind key focal points (`filter blur-[80px] opacity-25 bg-gradient-to-r from-blue-600 to-purple-600`).

### B. Typography & Micro-Hierarchy
* **Display Headings**: Tight letter-spacing (`tracking-tight` or `-0.02em`), optical leading (`leading-[1.1]`).
* **Body Text**: Slate-300 / Slate-400 with comfortable line-height (`leading-relaxed`).
* **Meta Labels & Badges**: Monospace or small caps (`font-mono text-xs uppercase tracking-wider text-slate-400`).

### C. Motion & Kinetic Polish
* **Scroll-Triggered Reveals**: Staggered fade-up entrances for cards and list items (`staggerChildren: 0.08`).
* **Hover State Dynamics**: Card hover combines `-translate-y-1` vertical lift with illuminated border glow.
* **Button Physics**: Active press feedback (`active:scale-[0.98] active:brightness-95`).

### D. Complete State Integrity
* **Loading Skeletons**: Tailored pulse skeletons mirroring exact component geometry.
* **Empty States**: Custom illustration, descriptive copy, and direct action CTA.
* **Error Boundaries & Toasts**: Floating non-blocking toast notifications with status icons.
