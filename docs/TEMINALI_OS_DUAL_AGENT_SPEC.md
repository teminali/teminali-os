# TEMINALI OS: DUAL-INTELLIGENCE ARCHITECTURAL SPECIFICATION
## "One AI Talks. One AI Works."

> **Document Status**: Production Design Specification  
> **Target Integration**: Teminali OS / Studio Engine  
> **Hardware Reference**: Apple M4 Pro (24 GB Unified Memory)  
> **Last Updated**: 2026-09-08  

---

## 1. Executive Summary & Philosophy

Existing AI assistant systems suffer from a fatal UX conflict:
* **The Voice Agent** must be fast (TTFT < 400ms), warm, emotionally perceptive, concise (2–4 spoken sentences), and uninterrupted by heavy background calculations.
* **The Coding Agent** must be deep, methodical, capable of reading 50,000+ tokens of repository ASTs, executing shell commands, and waiting 30–90 seconds for builds and test suites.

Attempting to merge both roles into a single model forces unacceptable trade-offs: either the voice assistant goes silent for a minute while analyzing files, or the coding assistant gives shallow, rushed answers to keep latency low.

**The Solution:** Decouple the intelligence into two distinct, cooperative agents connected via an asynchronous **Event Bus** and a **Structured Task State**:

```
                         USER
                           │
              ┌────────────┴────────────┐
              │                         │
           VOICE                     CHAT / IDE
              │                         │
              ▼                         ▼
    ┌──────────────────┐      ┌─────────────────────┐
    │ REALTIME AGENT   │      │   CODING AGENT      │
    │  ("Temi")        │      │                     │
    │ Qwen3 8B / 2.5   │      │ Qwen2.5-Coder 7B    │
    │ Always Resident  │      │ / Cloud APIs        │
    │ Fast (~350ms)    │      │ / Terminal & Tools  │
    │ Conversational   │      │ / Full Context AST  │
    └────────┬─────────┘      └──────────┬──────────┘
             │                           │
             └───────────┬───────────────┘
                         ▼
                ┌─────────────────┐
                │   EVENT BUS     │
                │       +         │
                │  TASK STATE     │
                └─────────────────┘
```

---

## 2. Component Breakdown

### A. Realtime Voice Intelligence (The Companion / "Temi")
* **Primary Role:** User interaction, voice presence, empathy, status reporting, intent classification, constraint injection.
* **Model Engine:** `qwen3:8b` (Q4_K_M, ~5.2 GB) or `qwen2.5:7b` (~4.7 GB).
* **Execution Mode:** Strictly standard conversational prose (thinking mode hard-disabled `/no_think` for voice).
* **Prompt Constraint:** Spoken prose only. Zero bullet points, zero markdown symbols, zero numbered lists. Breeze-TTS-2 ready.
* **Context Invariant:** **Never receives raw source code, ASTs, or terminal logs.** Receives only the distilled `FrontierTaskState` (~200–400 tokens), preserving sub-350ms TTFT.

### B. The Coding Worker (The Engineer)
* **Primary Role:** Repository exploration, file patching, terminal execution, test verification, git operations, deep debugging.
* **Model Engine:**
  * **Local Worker:** `Qwen2.5-Coder-7B-Instruct` (Q4_K_M, ~4.7 GB, 8k–16k context window).
  * **Cloud Worker (Escalation):** Claude 3.5 Sonnet / GPT-4o / Gemini 2.5 Pro (via API, 0 GB local RAM).
* **Execution Mode:** Unconstrained execution loop (via `frontierEngine.ts` and `diligenceEngine.ts`). Can run for minutes with deep reasoning enabled.

---

## 3. Communication Bridge: Structured Task State & Event Bus

### A. The Shared Task State Interface
```typescript
export interface FrontierTaskState {
  id: string;
  objective: string;
  status: "planning" | "working" | "testing" | "blocked" | "completed" | "failed";
  currentAction: string;
  progress: {
    filesInspected: number;
    filesModified: number;
    testsPassed: number;
    testsFailed: number;
  };
  plan: Array<{ step: number; description: string; status: "pending" | "active" | "done" }>;
  recentEvents: AgentEvent[];
  userConstraints: string[];
  blocker?: {
    reason: string;
    suggestion: string;
  };
  resultSummary?: string;
}
```

### B. Event Bus Schemas
The coding agent emits events at every phase transition; the voice agent listens to inform the user in real time:

| Event Name | Payload Highlights | Voice Agent Interpretation Example |
| :--- | :--- | :--- |
| `TASK_STARTED` | `task_id`, `objective` | *"I've handed that to the coding agent. It's examining the routes now."* |
| `PLAN_CREATED` | `steps: string[]` | *"The plan is ready—it's focusing on middleware and session storage."* |
| `FILE_MODIFIED` | `filepath`, `diff_lines` | *"It just updated auth/middleware.ts."* |
| `TEST_STARTED` | `test_file`, `runner` | *"The implementation is complete. It's running the test suite now."* |
| `TEST_FAILED` | `failures: string[]` | *"Two tests failed in the session cookie check. The coder is debugging that now."* |
| `BLOCKED` | `reason`, `missing_dep` | *"It hit a snag: the SESSION_SECRET environment variable is missing."* |
| `TASK_COMPLETED` | `summary`, `diffstat` | *"All done! All four tests passed and the JWT code is replaced with sessions."* |

### C. Mid-Flight Steerability (`USER_CONSTRAINT_ADDED`)
When the user speaks to the voice agent during execution:
1. User: *"Actually, don't use Redis. Keep it in-memory for now."*
2. Voice Agent immediately replies: *"Understood. Telling the coder to keep sessions local without Redis."*
3. Voice Agent posts event:
   ```json
   {
     "type": "USER_CONSTRAINT_ADDED",
     "constraint": "Do not introduce Redis; use in-memory local storage."
   }
   ```
4. Coding Agent reads the constraint in its next iteration and adapts the implementation plan without restarting.

---

## 4. Hardware Allocation on 24GB Unified Memory ("The Iron Wall")

```
┌─────────────────────────────────────────────────────────────┐
│                 Apple M4 Pro 24 GB Unified Memory           │
├─────────────────────────────────────────────────────────────┤
│  IMMORTAL RESERVED POOL (~15.5 GB) — NEVER UNLOADED         │
│  ├─ Voice Agent (Qwen3 8B / Qwen2.5 7B)            ~5.2 GB  │
│  ├─ faster-whisper (small.en + base.en VAD)        ~1.5 GB  │
│  ├─ Breeze-TTS-2 C++ Metal Pipeline                ~1.2 GB  │
│  ├─ Teminali OS / Studio UI + TS LSP               ~3.5 GB  │
│  └─ macOS System Base                              ~4.0 GB  │
├─────────────────────────────────────────────────────────────┤
│  FLEXIBLE WORKER POOL (~8.5 GB Headroom)                    │
│  ├─ Local Option: Qwen2.5-Coder-7B-Instruct                 │
│  │   (Q4_K_M ~4.7 GB + 8k–16k KV cache ~1.5 GB = ~6.2 GB)  │
│  │   → Total headroom remaining: ~2.3 GB (zero swap!)       │
│  │                                                          │
│  └─ Cloud Escalation Option (0 GB Local Memory):            │
│      Claude 3.5 Sonnet / GPT-4o / Gemini 2.5 Pro            │
│      → Auto-triggered for 30+ file tasks or high memory     │
└─────────────────────────────────────────────────────────────┘
```

### Safety Invariant:
**If memory pressure increases, the worker model is throttled, pruned, or switched to Cloud API. The Voice Agent is NEVER evicted.** Temi remains conscious, vocal, and responsive at all times.

---

## 5. Development Strategy

1. **Phase 1 (Active Focus):** Optimize and polish the standalone voice assistant pipeline on `http://localhost:8000` (whisper small.en + Breeze-TTS-2 + qwen2.5:7b / qwen3:8b, interruption latching, context memory).
2. **Phase 2:** Integrate `FrontierTaskState` and WebSocket Event Bus into `studio/server/gateway.js`.
3. **Phase 3:** Port the hardened voice runtime into Teminali OS as an autonomous companion overlay monitoring the coding agent.
