# Rule: Cumulative Battle Testing & Release Verification

## Core Mandate
The hands-free battle test (`studio/scripts/hands-free-temi-dev.mjs`) is the primary release gatekeeper and reliability benchmark for Teminali OS.

**NEVER DROP, REPLACE, OR ROTATE OUT TEST CASES.**
Every single battle test run must be **strictly cumulative and additive**:
> **Every test must test EVERYTHING already established PLUS all newly added features and edge cases.**

## 1. The Cumulative Test Matrix
Every battle test run MUST sequentially validate all accumulated domains:
1. **Identity, Presence & Natural Cadence**: Validates who Temi is, unscripted persona, and natural Italian cadence (matching reference `~/Desktop/temi-voice-audition/00-REFERENCE-bella.wav`).
2. **Architecture & Full-Duplex**: Confirms understanding of real-time full-duplex audio and local fast-paths.
3. **Sub-3-Second / 0-Token Computer Accessibility**:
   - Hard-coded local flows running in `< 50ms` consuming `0 model tokens`.
   - Must cover: Disk storage, Battery telemetry, System uptime & RAM, OS & processor architecture, File operations (open, play video on Teminali OS player, move, list).
4. **Cross-Turn Context Recall**: Verifies memory bridge persistence (e.g. recalling disk numbers or telemetry stated in prior turns).
5. **Strict Developer Capability Boundaries**: Strict refusal of external/physical actions (e.g. sending emails, making bookings), clearly stating they remain developer tasks.
6. **Affective Vocal Performance & Musicality**: Authentic singing (e.g. Italian *Volare*) with **zero** spoken stage directions, asterisks, or parenthetical annotations.
7. **Flexible & Intelligent Silence Gap**:
   - Pauses on incomplete thoughts or conjunctions (*"and"*, *"so"*, *"what is my..."*) must dynamically expand the silence window (up to 2400ms).
   - Crisp closure on complete commands (950ms–1100ms).
   - **Never** produce unprompted prompters (*"Still nothing"*, *"Is there something specific"*) during user silence.
8. **New Features**: Any new feature or bugfix must append its dedicated aggressive verification turns to the cumulative suite.

## 2. Release Gating Standard
- No update may be considered complete or ready for release without running the full cumulative battle test.
- The composite score must monotonically maintain or improve baseline thresholds (targeting 90%+).
- Regressions on any prior turn are blocking release failures.
