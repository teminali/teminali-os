# Teminali UI Frameworks & Component Blueprints

## 1. Primary Default Stack: React / Next.js + shadcn/ui + Tailwind CSS + Framer Motion

When a user in Teminali asks to build a website, web app, or frontend interface:
1. **If stack is unspecified**: Default to **Next.js (App Router) + React + Tailwind CSS + shadcn/ui + Framer Motion + Lucide Icons**.
2. **If user expresses preference**: Support their framework of choice, but prioritize `shadcn/ui`-compatible primitives for maximal pre-training accuracy and zero-defect code generation.

---

## 2. Standard Scaffolding & Setup Workflow

### Rapid Project Initialization
```bash
# Initialize Next.js project non-interactively
npx -y create-next-app@latest ./ --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm

# Initialize shadcn/ui
npx -y shadcn@latest init -d

# Install motion & icons
npm install framer-motion lucide-react clsx tailwind-merge
```

### Essential Core Component Set to Install
```bash
npx -y shadcn@latest add button card dialog dropdown-menu input badge tabs table sheet skeleton
```

---

## 3. Mandatory Layout & Component Architecture

### A. App Shell Layout (`src/app/layout.tsx`)
* Dark-mode glassmorphic theme root (`bg-[#0B0D14] text-slate-100 antialiased min-h-screen selection:bg-blue-500/30`).
* Ambient radial glow background (`fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-900/15 via-transparent to-transparent pointer-events-none`).
* Global sticky top navigation with `backdrop-blur-md bg-[#0D0F18]/80 border-b border-white/10`.

### B. Micro-Interactions & Framer Motion Standards
* **Entrance Transitions**:
  ```tsx
  <motion.div
    initial={{ opacity: 0, y: 16 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
  >
    {children}
  </motion.div>
  ```
* **Staggered Children**:
  ```tsx
  const container = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.08 } }
  };
  ```

### C. Standard Component Patterns
1. **Interactive Buttons**:
   * *Primary*: `bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/20 active:scale-[0.98] transition-all`
   * *Secondary*: `bg-white/5 border border-white/10 hover:bg-white/10 text-slate-200 transition-all`
2. **Surfaces & Cards**:
   * `bg-[#141724]/80 backdrop-blur-md border border-white/10 rounded-xl p-6 shadow-xl hover:border-white/20 transition-all duration-300`
3. **Stat / Metric Cards**:
   * Large bold values (`text-2xl font-bold tracking-tight text-white`), label (`text-sm font-medium text-slate-400`), and trend pill (`bg-emerald-500/10 text-emerald-400 text-xs px-2 py-0.5 rounded-full font-medium`).
4. **Data Tables & Lists**:
   * Alternating row hover (`hover:bg-white/[0.03] transition`), sticky header, and action buttons on row hover.
5. **State Handling**:
   * Loading state: `<Skeleton className="h-8 w-full bg-white/5" />`
   * Empty state: Centered icon, title, description, and action button.
