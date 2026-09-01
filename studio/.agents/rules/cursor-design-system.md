# 🎨 Teminali Design System (TDS) — Canonical Contract & Component Governance

> **Canonical System Contract for Teminali Suite & Autonomous AI Agents**
> Ecosystem: **Teminali Studio**, **Teminali Cut**, **Teminali Guardian**, and all generated web applications.
> Mandate: Protect the **Classic Cursor Obsidian Dark** aesthetic at all costs during updates, features, and refactors. Every UI change MUST be implemented at the centralized component primitive level (`src/components/ui/`) for 100% reusability and visual consistency.

---

## 1. Zero-Slop Design Principles (Cursor Obsidian Dark)

1. **Nuanced Dark Palette**:
   - Deep Obsidian bases: `#08090E`, `#090b10`, `#0c0e14`, `#10131c`, `#141724`.
   - Never use raw `#000000` or washed out gray `#333333`.
   - Never allow pure `#ffffff` frames or unstyled white canvas flashes in iframes.

2. **1px Inset Border Luminance**:
   - Hairline 1px borders with top-edge reflection: `border-white/10` or `border-t border-white/15 border-x border-white/5 border-b border-white/5`.

3. **Signature Accent Colors**:
   - **Postman Orange**: `#FF6C37` (Primary brand accent, active tabs, focused rings, send actions, interactive code toggles).
   - **Emerald Glow**: `#10b981` / `#22c55e` (Live status, completed actions, positive telemetry).
   - **Amber / Gold**: `#f59e0b` / `#eab308` (Warnings, specialist skills, qualification notes).
   - **Violet / Purple**: `#818cf8` / `#a855f7` (AI reasoning, plan mode, smart orchestration).
   - **Rose / Coral**: `#f43f5e` / `#fb7185` (Errors, stop stream buttons, destructive actions).

4. **Typography Hierarchy**:
   - UI Text: Clean system display font (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`).
   - Code & Telemetry: Monospace (`ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`).
   - Badges & Keycaps: `font-mono text-3xs uppercase tracking-wider`.

---

## 2. Centralized Reusable Component Primitives (`src/components/ui/`)

All UI components MUST be imported from `src/components/ui/` rather than creating ad-hoc or duplicated markup:

* **`Button`** (`src/components/ui/Button.tsx`):
  - Variants: `primary`, `secondary`, `ghost`, `danger`, `tab`, `pill`.
  - Sizes: `xs`, `sm`, `md`, `lg`.
  - Supports shortcuts (`⌘K`, `⌘J`), loading state, icons.
* **`Badge`** (`src/components/ui/Badge.tsx`):
  - Variants: `sky`, `emerald`, `amber`, `purple`, `rose`, `neutral`, `shortcut`, `model`.
  - Sizes: `xs`, `sm`, `md`. Supports optional pulsing dot.
* **`Modal`** (`src/components/ui/Modal.tsx`):
  - Canonical floating dialog with backdrop blur, custom header, body scroll, and footer.
* **`SegmentedTabs`** (`src/components/ui/SegmentedTabs.tsx`):
  - Segmented pill bar and underline tabs for switching modes, categories, and views.
* **`Input`** (`src/components/ui/Input.tsx`):
  - Search bars, text inputs with optional prefix icons and one-click clear button.
* **`Card`** (`src/components/ui/Card.tsx`):
  - Obsidian glass cards with variants (`default`, `glass`, `interactive`, `bubble`).

---

## 3. Strict Component-Level Governance Law

> ⚠️ **RULE FOR ALL AI ASSISTANTS & CONTRIBUTORS**:
> Whenever updating, improving, or adding any UI in Teminali Studio:
> 1. Check if a canonical component exists in `src/components/ui/`.
> 2. If styling or behavior needs improvement, **update the shared component in `src/components/ui/`** so the improvement propagates everywhere consistently.
> 3. NEVER create duplicate one-off styled buttons, modals, or tab switchers in individual page components.
