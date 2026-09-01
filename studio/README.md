# Frontier Code ⚡

> **The local-first, skill-native autonomous coding agent.**  
> Sub-second local execution at zero token cost, paired with deterministic frontier cloud escalation.

---

## 🌟 Core Pillars

1. **Local-First Speed (Devstral 24B via Ollama Loopback)**
   - High-throughput, mechanical edits, AST refactoring, and test loops run locally with **0 token cost** and **sub-second latency**.
   
2. **Deterministic Frontier Escalation (Gemini 3.7 Flash & Claude Sonnet 5)**
   - Complex architectural decisions, multi-modal frame reasoning, and difficult bug repair escalate cleanly to top-tier frontier models under strict process-scoped budgets.

3. **Two-Phase Usage Accounting & Safe Gateways**
   - Worst-case pre-flight reservations ensure hard budget bounds are never exceeded.
   - Live byte-preserving JSON/SSE stream inspection reconciles to exact provider-reported token usage at EOF.

4. **Domain-Specific Skill Ecosystem**
   - **`website-builder`**: End-to-end information architecture, design token systems, responsive media queries, and WCAG AA accessibility verification.
   - **`kerf-video-editor`**: Direct MCP timeline manipulation for video editing, beat sync cuts, and kinetic captions.
   - **`code-reviewer` & `qa-verifier`**: Independent multi-pass automated test & regression verifiers.

5. **Deep Integration with Kerf Video Editor**
   - Ships as the default, first-class native AI Copilot engine inside **Kerf** ([github.com/teminali/kerf](https://github.com/teminali/kerf)).

---

## 🛠️ Architecture

```
                 ┌──────────────────────────────────────┐
                 │       Frontier Code Developer        │
                 │   (OpenCode CLI / Kerf Video Editor) │
                 └──────────────────┬───────────────────┘
                                    │
                                    ▼
                 ┌──────────────────────────────────────┐
                 │     Local HTTP Gateway (127.0.0.1)   │
                 │  - Ephemeral token authentication    │
                 │  - Priority Quota Pool               │
                 │  - 2-Phase Budget & Usage Settlement │
                 └──────────┬────────────────┬──────────┘
                            │                │
             Priority 1     │                │ Priority 2+
            (Local Lane)    │                │ (Cloud Escalation)
                            ▼                ▼
                 ┌────────────────────┐   ┌────────────────────┐
                 │    Ollama Loopback │   │   Frontier Cloud   │
                 │     (Devstral 24B) │   │  Gemini 3.7 Flash  │
                 │     $0.00 / M tok  │   │  Claude Sonnet 5   │
                 │    <100ms latency  │   │  GPT-OSS 120B      │
                 └────────────────────┘   └────────────────────┘
```

---

## 🚀 Quick Start

### 1. Run the Gateway
```bash
npm run gateway:start
```

### 2. Launch with Local-First Devstral & Cloud Escalation
```bash
npm run agent:start-enhanced
```

### 3. Run Benchmark Verification Suites
```bash
npm run test                   # Run 49 gateway & routing unit tests
npm run benchmark:003:score    # Run Website Builder SaaS Launch Benchmark
```

---

## 📄 License
MIT © 2026 teminali & Frontier AI
