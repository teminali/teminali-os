# Teminali OS — Agent Development Rules & Standards

## 1. Cumulative Battle Testing (Non-Negotiable)
The hands-free battle test (`studio/scripts/hands-free-temi-dev.mjs`) is our primary release gate and verification tool.
- **Strictly Additive**: Tests must NEVER drop, swap, or rotate out prior test cases to test new things.
- **Full Coverage Every Time**: Every single execution must test **all accumulated capabilities** (Identity, Architecture, Sub-3s/0-token Accessibility, Cross-Turn Recall, Developer Boundaries, Italian Singing, Flexible Silence Gap) **PLUS** any new features or behaviors.
- **Release Standard**: No release or update is acceptable without running the full cumulative battle test and verifying zero regressions.

## 2. Hard-Coded Local Accessibility Architecture
- All general computer accessibility tasks (storage, battery, uptime, RAM, OS info, file opening, video player playback, file listing, file moving) must execute via hard-coded fast paths.
- **Latency Target**: Sub-3-second end-to-end (typically `< 50ms`), consuming **0 model tokens**.
- Both the Voice Assistant and Studio Chat must share the unified system actions engine (`systemActions.ts` and `compoundActionRunner.ts`).

## 3. Strict Developer Boundaries
- If a requested task cannot or should not be performed locally/autonomously (e.g., sending emails, making bookings, modifying production servers), the assistant must be strictly clear that it remains developer work.

## 4. Intelligent & Flexible Silence Gap (No Robotic Waiting)
- Do not use a static, rigid wait for silence.
- Silence handling must be dynamically intelligent:
  - Incomplete clauses, thinking hesitations, or connectors (*"and"*, *"so"*, *"or"*) dynamically stretch the silence gap (up to 2400ms).
  - Completed commands close crisply (950ms–1100ms).
  - The voice persona must **never** speak unprompted prompters into user silence (*"Still nothing"*, *"Is there something specific"*).

## 5. Voice & Affective Authenticity
- Natural Italian cadence and timbre matching reference `~/Desktop/temi-voice-audition/00-REFERENCE-bella.wav`.
- **Zero Stage Directions**: Parenthetical or asterisk narrative actions (like `(sings)`, `*chuckles*`) must never leak into spoken audio or captions.

## 6. Zero Legacy Code & Ruthless Pruning (Always Clean)
- **Delete Obsolete Code**: When implementing improved architectures or refactoring, ALWAYS delete superseded, dead, or deprecated legacy code.
- **No Parallel Clutter**: Never leave two duplicate systems or abandoned parallel paths. Maintain a single, clean source of truth.
- **Max Capability, Min Code Footprint**: Write lean, highly scalable, instantly understandable code that any developer or AI assistant can comprehend in seconds.
