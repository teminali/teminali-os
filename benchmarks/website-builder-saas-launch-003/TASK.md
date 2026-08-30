# B2B SaaS Launch Site & Pricing Page (DevStream)

You are tasked with building a high-converting, accessible, and responsive marketing and pricing website for **DevStream**, a developer telemetry ingestion platform.

Read `src/site-data.json` for canonical brand facts, pricing tiers, and claim evidence. Do not invent unverified metrics or partner logos.

## Requirements

1. **Semantic HTML & Landmarks**:
   - Proper `<header>`, `<nav>`, `<main>`, and `<footer>` landmarks.
   - Exact heading hierarchy starting with a single `<h1>` in the hero section, followed by `<h2>` section titles and `<h3>` card headers.
2. **Hero & Content Flow**:
   - Clear value proposition above the fold with primary CTA button linked to `#pricing` or `#signup`.
   - Live metrics bar displaying verified benchmark statistics from `src/site-data.json`.
3. **Interactive Pricing Grid**:
   - Monthly / Annual billing toggle that dynamically updates displayed tier prices and discount indicators.
   - Accessible button states on each tier with clear tier designations (Starter, Team, Enterprise).
4. **Lead Capture & Contact Form**:
   - Email format validation, required fields, and accessible error message containers (`aria-live="polite"` or `aria-describedby`).
   - Anti-spam honeypot input field hidden from screen readers and sighted users.
5. **Responsive Design System & Tokens**:
   - Defined CSS custom properties in `:root` for colors, typography, spacing, and radius.
   - Mobile (375px), Tablet (768px), and Desktop (1440px) media queries with zero horizontal page scroll.
6. **Accessibility & Quality**:
   - WCAG AA color contrast, visible `:focus-visible` styling on all interactive elements.
   - `prefers-reduced-motion` media query to disable heavy transitions for users requesting reduced motion.

Run `npm test` to verify the visible contract. Ensure the implementation remains lightweight, fast, and dependency-free.
