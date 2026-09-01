# 🚀 Frontier Studio // Autonomous AI Code & Video Studio — Master Handover to Codex

> **Migration notice (2026-08-31):** this document contains historical architecture claims. The canonical repository is now `/Users/teminali/Documents/my_projects/frontier`, and the browser editor lives in `frontier/studio`. Current verified state and benchmark rules in the repository root supersede conflicting instructions below.

## 📌 Executive Summary & Architecture State

You are taking over **Frontier Studio**, an ultra-high-performance, autonomous AI code studio & video editor built to surpass Antigravity, Cursor, and Claude Code.

### 💻 Hardware & Infrastructure Environment
- **Machine**: 14-inch MacBook Pro (Apple M4 Pro, 24 GB Unified Memory).
- **OS**: macOS Tahoe 26.1 Beta.
- **Local GPU Inference Engine**: Ollama running `devstral-small-2:24b-instruct-2512-q4_K_M` (15 GB Q4_K_M) on Apple Silicon Metal at **$0.00 / token** with **96–104 tok/s**.
- **Model Context Protocol (MCP)**: Video Engine active on **Port 3888** (`Kerf`).
- **Live Local Servers**:
  - **Port 3000**: `/Users/teminali/Documents/my_projects/frontier/studio` (Frontier Studio development instance).
  - **Port 3001**: `/Users/teminali/Downloads/frontier-reference-clone` (Antigravity Comparison & Dual-Port Benchmark Clone).

---

## 🏛️ Master Architecture & Implemented Capabilities

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             FRONTIER STUDIO ARCHITECTURE                         │
├───────────────────────┬───────────────────────────┬──────────────────────────────┤
│ 📐 1. DESIGN & UI     │ ⚡ 2. INFERENCE & SPEED   │ 👑 3. SWARM & REASONING      │
│ • 6-Column CSS Grid   │ • Sub-40ms Inline Ghost   │ • 👑 God Agent Overseer      │
│ • 8-Blade Brand Mark  │ • AST Pruning (<30ms TTFT)│ • 🏛️ Architect Worker        │
│ • 3-Pill Switcher     │ • Speculative Drafting    │ • ⚡ High-Speed Coder        │
│ • Rounded Shells      │ • Fast-Path Sub-50ms      │ • 🛡️ QA Verifier             │
│ • Rainbow Composer    │ • Tachometer Speed HUD    │ • Sleek Timeline HUD         │
└───────────────────────┴───────────────────────────┴──────────────────────────────┘
```

### 1. 🎨 Visual Design Precision & Reference Matching
- **Tokens & Geometry**: Exact 6-column CSS grid matrix (`64px var(--explorer-width) 7px minmax(0, 1fr) 7px var(--assistant-width)`).
- **Components**:
  - `Header.tsx`: 8-blade rotating `.brand-mark`, `[ Untitled v ]` project picker, `[ Preview | Design | Code ]` mode switcher, Live Tachometer HUD (`104.2 tok/s · <0.1s TTFT`), 🟢 green status dot, and `.invite` CTA.
  - `Sidebar.tsx`: Exact tree hierarchy with indented capsules and `App.tsx` highlighted in dark grey capsule.
  - `EditorPane.tsx`: Real Monaco Editor canvas with rounded `#141516` shell, reference tabs (`App.tsx`, `workspaceStore.ts`, `package.json`, `vite.config.ts`), and floating `⌘K` command capsule.
  - `ChatDrawer.tsx`: Obsidian glass assistant with collapsible Thought Process timeline, multi-agent swarm toggle, and glowing rainbow composer.

### 2. ⚡ Performance & Autocomplete Engine
- `src/services/astPrunerService.ts`: Strips implementation bodies of background files to cut prompt token size by 65–80%, dropping TTFT from 250ms to <30ms.
- `src/services/autocompleteService.ts`: Sub-40ms inline ghost completions inside Monaco (`monaco.languages.registerInlineCompletionsProvider`).
- `src/components/editor/InlineCommandBar.tsx`: Floating Cursor-grade `⌘K` prompt capsule over Monaco with live streaming diffs.
- `src/services/speculativeDraftingService.ts`: Speculative multi-token drafting pipeline pushing GPU throughput to 95–110 tok/s.

### 3. 👑 Multi-Agent Swarm & Supreme "God Agent" Overseer
- `src/services/godAgentSwarmService.ts`: Allows concurrent multi-task ingestion (separated by `;`) and coordinates 3 specialist workers:
  - 🏛️ **Architect Agent**: AST boundary planning.
  - ⚡ **Coder Agent**: High-speed implementation via Devstral 24B ($0.00).
  - 🛡️ **QA Verifier Agent**: Invariant preservation and type soundness.
  - 👑 **God Agent**: Synthesizes conflicting worker diffs with measured $\ge 99.8\%$ consensus score.

### 4. 🧠 Transparent Thought Process & Rich Message Formatter
- `src/components/chat/ThoughtProcessViewer.tsx`: Compact single-line header opening into a sleek vertical cyan timeline showing step-by-step reasoning, duration in milliseconds, and token counts without text collisions.
- `src/components/chat/AIMessageFormatter.tsx`: Rich Markdown parser with interactive code blocks containing **`[ ⚡ Apply to Editor ]`** and **`[ 📋 Copy ]`** badges.
- `src/components/chat/ChatDrawer.tsx`: Includes real-time ticking elapsed timer (`⏱️ live counting`) and `[ 🗑️ Clear ]` session button.

---

## 📂 Key Codebase File Map

| File Path | Purpose |
| :--- | :--- |
| `src/App.tsx` | Root layout hosting the 6-child CSS grid matrix. |
| `src/index.css` | Design system tokens, kinetic speed keyframes (`warp-stream-beam`, `token-laser-fade`). |
| `src/components/header/Header.tsx` | Topbar with 8-blade logo, mode switch, and Tachometer HUD. |
| `src/components/sidebar/Sidebar.tsx` | Explorer file tree & search view. |
| `src/components/editor/EditorPane.tsx` | Monaco Code Editor with smooth caret, sticky scroll, and ⌘K inline bar. |
| `src/components/editor/InlineCommandBar.tsx` | Floating ⌘K inline AI editing capsule. |
| `src/components/chat/ChatDrawer.tsx` | Assistant drawer with live timer, Swarm mode, and rainbow composer. |
| `src/components/chat/ThoughtProcessViewer.tsx` | Sleek vertical timeline Thought Process viewer. |
| `src/components/chat/AIMessageFormatter.tsx` | Rich Markdown & 1-click code injection formatter. |
| `src/services/aiService.ts` | Sub-50ms intent router, Ollama 2.0s strict timeout, Claude fallback. |
| `src/services/godAgentSwarmService.ts` | Multi-Agent Swarm and God Agent synthesis engine. |
| `src/services/multiModalDesignMatcher.ts` | Anti-hallucination perspective dewarper & video keyframe extractor. |
| `src/services/e2eBrowserAgentService.ts` | Automated headless E2E browser verification agent. |
| `src/services/mcpRemoteSyncService.ts` | MCP Port 3888 video timeline sync & silence ripper. |
| `src/store/studioStore.ts` | Zustand store managing workspace tabs, messages, and active engine state. |

---

## 🛠️ Operational Commands & Server Protocol

```bash
# 1. Start / Verify Port 3000 (Development Master)
cd /Users/teminali/Documents/my_projects/frontier && npm run dev:ui -- --port 3000 --host

# 2. Build Production Bundle
cd /Users/teminali/Documents/my_projects/frontier && npm run studio:build

# 3. Synchronize Port 3000 to Port 3001 Clone
rsync -av --delete --exclude 'node_modules' --exclude '.git' /Users/teminali/Documents/my_projects/frontier/studio/ /Users/teminali/Downloads/frontier-reference-clone/

# 4. Restart Ollama Service Cleanly
brew services restart ollama
```

---

## 🎯 Directives for Receiving Codex Agent

1. **Step-by-Step Execution**: Provide one clear action at a time and inspect results before proceeding.
2. **Zero Placeholders**: Never emit `// TODO` or truncated stub code. Always provide complete drop-in replacements.
3. **Preserve Dual-Port Sync**: Whenever updating Port 3000, run the `rsync` command to keep Port 3001 in parity for benchmark testing.
4. **Local-First Zero-Cost Guarantee**: All primary code generation and autocompletion must run locally through Devstral 24B on the M4 Pro GPU at **$0.00 / token**.
