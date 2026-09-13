# Hands-Free Temi Dev (`hands-free-temi-dev`)

**Hands-Free Temi Dev** is an autonomous, audible, self-improving multi-agent voice-to-voice testing and development engine for **Teminali OS**.

Instead of static, typed assertions or synthetic scripts, `hands-free-temi-dev` conducts a genuine, spoken dialogue between two intelligent voice agents in the room:
1. **AI Test Assistant (The Tester)**: Speaks aloud through the system speakers using high-fidelity system TTS (`Ava (Enhanced)` on macOS / `powershell` on Windows / `espeak` on Linux), challenging Temi dynamically based on what she actually answers.
2. **Temi (The System Under Test)**: Synthesizes responses via Gemini Live native audio (48kHz Int16 PCM) in an unmistakable Italian accent modeled on **Benedetta Porcaroli ("Bella")** from `~/Desktop/temi-voice-audition/00-REFERENCE-bella.wav`, managing tool delegations, machine inspection, system clock awareness, singing, and conversational memory.

---

## 1. System Architecture

```mermaid
graph TD
    A[Hands-Free Test Assistant] -->|Audible Speech via macOS TTS| S[Room / Speakers]
    A -->|Dispatches Spoken Turn via CDP| T[Teminali OS Studio]
    T -->|Gemini Live Native Audio WS| G[Gemini Live API]
    G -->|Native Audio Stream 24kHz PCM| T
    T -->|Plays Spoken Audio in Italian Accent| S
    T -->|Live Capture Buffer 48kHz| C[Acoustic & Voice Evaluator]
    C -->|Measures Latency, RMS, Silence, Accent| E[Turn Scorer]
    T -->|Periodic CDP Screenshot| SS[Visual UI Diagnostics]
    SS -->|Checks DOM Overflows & Orb Ring| E
    T -->|Requests Tool Execution| AP[Security Approval Gate]
    A -->|Verbal & Programmatic Approval| AP
    E -->|Updates Historical Metrics| L[Self-Improvement Ledger]
```

### Key Capabilities
- **Audible Dual-Voice Dialogue**: Every challenge is spoken aloud into the room. The user hears the testing assistant formulate the question, and hears Temi answer back in real time.
- **Voice Persona & Italian Accent Guarantee**:
  - Target: `~/Desktop/temi-voice-audition/00-REFERENCE-bella.wav` (Benedetta Porcaroli as Bella).
  - Prompts enforce Italian accent with rounded melodic vowels, softened consonants, lifted musical cadence, and audible breathing at both prompt **primacy** (top) and **recency** (bottom).
  - Prebuilt Voice Options calibrated to audition speeds:
    - **Sulafat (153 wpm)**: Natural Italian conversational pace (Default).
    - **Aoede (115 wpm)**: Lush, unhurried, warm melodic cadence.
    - **Gacrux (129 wpm)**: Measured and deliberate.
    - **Vindemiatrix (102 wpm)**: Deep, thoughtful, deliberate.
    - **Callirrhoe (208 wpm)**: Quick and bright.
- **Visual & UI Rendering Diagnostics**:
  - Periodic screenshots taken via CDP (`Page.captureScreenshot`) at turn start, tool approval gates, and response settled states into `benchmark-results/hands-free-temi-dev/screenshots/`.
  - DOM inspection checking for bubble overflow, text truncation, font scale consistency, and ring animation state.
- **Hands-Free Approval Resolution**: When Temi executes delegated system tools that require safety confirmation (e.g. `df -h && du -sh ~/Library/Caches`), the assistant speaks aloud: *"Yes Temi, I allow you to run that command"*, and programmatically resolves the approval banner. The test never hangs.
- **Self-Improving Ledger**: Tracks performance across runs in `self_improvement_ledger.json`, scoring audio quality, latency, accent fidelity, reasoning, and UI health, automatically logging insights and identifying high-water marks.

---

## 2. Issues Discovered & Resolved in Teminali OS

During the development and execution of `hands-free-temi-dev`, five critical voice pipeline defects were discovered and permanently resolved:

### Issue 1: Flashing `gateway-unreachable` Error Banner
- **Symptom**: A persistent red error banner appeared stating: `Temi's voice hit an error: gateway-unreachable: The local Frontier gateway is not reachable, so voice cannot authenticate.`
- **Root Cause**: Both `TOKEN_FETCH_TIMEOUT_MS` in the browser client (`geminiLiveEngine.ts`) and `GEMINI_LIVE_MINT_TIMEOUT_MS` in the backend gateway (`server/gateway.js`) were hardcoded to an aggressive **8,000 ms (8s)**. Whenever network latency to Google's `v1alpha` token minting endpoint exceeded 8 seconds, the client aborted the fetch with an `AbortError`. The client's catch block incorrectly classified all fetch errors as `gateway-unreachable`.
- **Resolution**:
  - Increased token mint timeouts to **25,000 ms** in both `studio/server/gateway.js` and `studio/src/services/voice/geminiLiveEngine.ts`.
  - Updated `studio/src/services/voice/geminiLiveToken.ts` to detect `AbortError` / `TimeoutError` and report retryable `mint-failed` instead of misleading `gateway-unreachable`.
  - Added auto-dismissal of stale voice error banners on `protocol.onConnected` in `TemiVoiceStage.tsx`.

### Issue 2: Premature Audio Chunk Cutoffs & Stutter on Long Utterances
- **Symptom**: During complex or paragraph-length answers, Temi's voice would cut off after 1–2 seconds, and the remaining 30+ seconds of speech would spill into the subsequent user turn.
- **Root Cause**: 
  1. `chunkSettleTimer` was set to only **450ms** and resolved without checking `!isSpeakingRef.current` or `!audio.isTTSPlaying`. When Gemini Live naturally paused between sentences for >450ms, the turn prematurely settled.
  2. In `audio.onTTSProgress`, `liveVoiceCapture` resolved as soon as `shown.length >= pending.length`, which occurred before remaining audio chunks had finished arriving.
- **Resolution**:
  - In `TemiVoiceStage.tsx`, debounced `chunkSettleTimer` to **850ms** and `onTTSPlaybackStopped` to **600ms**.
  - Enforced strict checks ensuring audio has completely finished playing (`!isSpeakingRef.current && !audio.isTTSPlaying && delegationsInFlightRef.current === 0`) before resolving live voice captures.
  - Removed early resolution from `onTTSProgress`.

### Issue 3: Stale Transcript & Prior-Turn Queue Leakage
- **Symptom**: When turns ran in continuous mode, Turn N would sometimes display the transcript from Turn N-1.
- **Root Cause**: Store fallback logic in `buildCapturedVoicePayload()` picked up the last assistant message from `frontierMessages` globally, which still held the prior turn's message while a tool was in flight.
- **Resolution**:
  - Added `msgCountAtStart` snapshots across `performVoiceTurn`, `startVoiceCapture`, and `runVoiceTestTurn` to scope store lookups strictly to messages created *after* the current turn began.
  - Prioritized live scoped `turnCaptions` over the store.

### Issue 4: Tool Approval Deadlock in Autonomous Voice Sessions
- **Symptom**: When Temi delegated terminal commands (e.g. checking disk space), the UI spawned an approval banner (`[Allow] [Always] [Refuse]`), pausing execution and blocking subsequent voice turns.
- **Root Cause**: No programmatic interface existed for test harnesses to query pending approvals or grant permissions.
- **Resolution**:
  - Exposed `hasPendingApproval()` and `approvePendingCommand()` on `window.__temiVoiceTest`.
  - Enhanced `hands-free-temi-dev` to detect approval requests verbally, speak the approval aloud into the room, and programmatically grant approval.
  - Added follow-up response capture (`waitForSpokenResponse`) so the tool's spoken result is captured on the same turn.

### Issue 5: Dilution of the Italian Accent & Audition Candidates
- **Symptom**: Temi was defaulting or drifting into a generic American accent, and the voice option `Vindemiatrix` was missing from the UI.
- **Root Cause**: The Italian accent prompt was buried in the middle of `TEMI_PERSONA` and was followed by 70 lines of examples and memory recall atoms. Furthermore, `localStorage` had drifted to `Callirrhoe` (208 wpm) which overpowered the melodic Italian vowel cadence.
- **Resolution**:
  - Reinforced Italian persona and Benedetta Porcaroli style at the very start of `TEMI_PERSONA` and anchored a closing accent law at the very end.
  - Formally integrated `Vindemiatrix` into `VOICE_OPTIONS` alongside `Sulafat`, `Aoede`, `Gacrux`, and `Callirrhoe`.
  - Reset default voice to `Sulafat` (153 wpm).

### Issue 6: False Barge-In from Table Scratching, Desk Taps & Mechanical Friction
- **Symptom**: Scratching the table or tapping the desk near the laptop caused Temi to immediately get cut off mid-speech, or caused Gemini to hallucinate answers to friction noise when silent.
- **Root Cause**: 
  1. Mechanical friction vibrates directly through the laptop chassis into the built-in microphone capsule, generating high broadband RMS (0.05–0.15), but zero harmonic pitch periodicity (`clarity < 0.35`, `f0 = 0`).
  2. In `voiceActivity.ts`, the loudness route `const loud = rms > 0.045` returned `true` even when `ducked = true` (assistant speaking), completely bypassing the pitch clarity check (`PITCH_CLARITY_DUCKED = 0.82`).
  3. After just 3 frames (60 ms), `Endpointer` emitted `speech-start`, calling `openActivity()`, firing `tts_interrupt`, and sending `activityStart: {}` to Gemini Live, abruptly killing Temi's voice playback.
- **Resolution**:
  - In `voiceActivity.ts`, required genuine pitch periodicity (`periodic && rms > pitchFloor`) for barge-in while `ducked = true`. Broadband mechanical noise without vocal resonance can never interrupt Temi.
  - In `micEndpoint.ts`, added `periodicFramesInTurn` tracking in `MicEndpointer`. If a turn ends with zero periodic vowel frames, it is classified as mechanical noise and emitted as `discarded` rather than `speech-end`.
  - In `geminiLiveEngine.ts`, separated `speech-end` from `discarded` events. Discarded noise events silently reset the in-flight activity without sending `activityEnd`, preventing Gemini from answering desk noise.

---

## 3. Automated Post-Test Lifecycle Workflow

`hands-free-temi-dev` incorporates an automated end-of-test lifecycle:
1. **Closes Electron Dev**:
   Programmatically invokes `app:quit` and closes the Electron window (`pkill -f "electron.*main.cjs"`), freeing audio hardware and clearing in-memory state.
2. **Speaks the Report Brief Aloud**:
   The test assistant speaks a spoken summary into the room using system TTS (`Ava (Enhanced)` on macOS), announcing:
   - Total turns completed
   - Average composite score (0–100)
   - Voicing percentage
   - Accent & persona confirmation
   - Mechanical noise rejection status
3. **Reruns the Dev App**:
   Once speech finishes, the engine automatically relaunches `npm start` in the background, waits for ports `3000` (Vite) and `9222` (CDP) to become responsive, and leaves the studio fresh and ready for interaction or the next test.

---

## 4. How to Run `hands-free-temi-dev`

### Execution
Run the automated test suite directly from the `studio` workspace:
```bash
npm run voice:hands-free
```
Or directly with Node:
```bash
node scripts/hands-free-temi-dev.mjs
```

### Resuming & Progressive Testing in a New Chat
To continue testing or development in a new chat:
1. Verify the Electron dev app is running (`lsof -i :3000` and `lsof -i :9222`). If not, launch `npm start`.
2. Run `npm run voice:hands-free` to execute a fresh audible evaluation run.
3. Review the historical ledger at `studio/benchmark-results/hands-free-temi-dev/self_improvement_ledger.json` to inspect performance trends and high-water marks.
4. Keep all features and fixes versioned with atomic git commits (`git log -n 5 --oneline`).

---

## 5. Benchmark Artifacts & Reports

Every run of `hands-free-temi-dev` generates structured outputs in `studio/benchmark-results/hands-free-temi-dev/`:
- **`turns/turn_01.wav` ... `turn_08.wav`**: Lossless 48kHz RIFF WAV audio files of each spoken response.
- **`screenshots/turn_XX_start.png`, `turn_XX_settled.png`**: Visual state screenshots capturing UI rendering.
- **`hands_free_report.json`**: Turn-by-turn metrics (duration, RMS dBFS, latency to first byte, composite score).
- **`self_improvement_ledger.json`**: Historical record tracking aggregate scores, learnings, and performance trends across test iterations.

---

## 6. Extension Guidelines for Future Development

When adding new voice capabilities or tools to Teminali OS:
1. **Preserve Audio Debounce Invariants**: Do not lower `chunkSettleTimer` below 750ms in `TemiVoiceStage.tsx` without testing long-form streaming answers.
2. **Always Handle Tool Approvals**: If adding new privileged tools, ensure they integrate with `useSpokenApproval` so users can approve them out loud.
3. **Accent Primacy & Recency**: Ensure any system instruction updates keep the Italian accent and audible breath rules at the top and bottom of the prompt to avoid model drift.
4. **Preserve Noise Rejection**: Never allow unvoiced loudness alone to trigger barge-in while ducked; real speech requires vowel periodicity ($F_0 \in [80, 420]$ Hz).
5. **Run Continuous Benchmarking**: Run `npm run voice:hands-free` before releasing any changes to verify that the self-improvement ledger composite score remains >= 80/100.

