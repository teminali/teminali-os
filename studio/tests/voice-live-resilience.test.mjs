/**
 * The live lane's failure modes, pinned.
 *
 * Everything here stands for something that happened or was traced on the way
 * to a demo: two sockets after a development launch, a sentence split in half
 * by a thinking pause, a test suite run twice because two paths delegated the
 * same turn, a token minted every two seconds all night, a microphone stuck on
 * "connecting" behind a cafe portal, and a session Google ended on its own
 * while the reconnect that followed had forgotten the conversation.
 *
 * `handleServerMessage` is private to TypeScript and ordinary at runtime, so
 * the inbound behaviour is driven directly with the message shapes Gemini
 * sends — no socket, no network, no mock of the SDK. Where a behaviour really
 * does need a live connection (the order of the awaits inside `connect()`, the
 * deadline on a fetch), the source is asserted over instead, the way
 * `voice-editor-wiring.test.mjs` does, and the comment says which failure the
 * assertion stands in for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  GeminiLiveEngine,
  backoffDelayMs,
  isRetryableTokenFailure,
  parseDurationMs,
  goAwayRestartDelayMs,
  END_OF_TURN_SILENCE_MS,
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  TOKEN_RETRY_BASE_MS,
  TOKEN_RETRY_CAP_MS,
  MAX_RECONNECT_ATTEMPTS,
  CONNECT_TIMEOUT_MS,
  RECONNECT_GAVE_UP_NOTE,
} from "../src/services/voice/geminiLiveEngine.ts";
import { DEFAULT_ENDPOINTER } from "../src/services/voice/turnTaking.ts";

const engineSource = await readFile(new URL("../src/services/voice/geminiLiveEngine.ts", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../src/services/gatewayClient.ts", import.meta.url), "utf8");
const gatewaySource = await readFile(new URL("../server/gateway.js", import.meta.url), "utf8");

/** An engine with its outbound messages collected. Never connected. */
function harness() {
  const engine = new GeminiLiveEngine();
  const messages = [];
  const notes = [];
  const errors = [];
  engine.onMessage = (msg) => messages.push(msg);
  engine.onNote = (note) => notes.push(note);
  engine.onError = (err) => errors.push(err);
  return { engine, messages, notes, errors };
}

const toolCallMessage = (id = "call-1") => ({
  toolCall: {
    functionCalls: [{ id, name: "ask_the_assistant", args: { task: "Run the test suite.", spoken_note: "Let me look." } }],
  },
});

/** One 24 kHz PCM frame, base64, so a turn can be given real audio to mint a
    generation off. Two silent samples is enough; the resampler is not what is
    under test here. */
const AUDIO_MESSAGE = { data: Buffer.from(new Int16Array([0, 0]).buffer).toString("base64") };

// ───────────────────────────────────────────── "run the tests", exactly once

test("a turn the shell already delegated does not delegate again through her", () => {
  // The operator says "run the tests". The rules path in `machineAction.ts`
  // recognises it, the shell delegates and barges in — and the model, which
  // began generating the moment its own VAD closed the turn, reaches for
  // `ask_the_assistant` to delegate the same sentence. Both used to land. The
  // suite ran twice, which on camera is the worst thing in this file.
  const { engine, messages } = harness();
  engine.sendBargeIn();
  engine.handleServerMessage(toolCallMessage());
  assert.equal(messages.filter((m) => m.type === "tool_call").length, 0);
});

test("an undelegated turn still reaches the assistant", () => {
  // The complement, and the thing the gate must not break: when the shell has
  // not answered the turn, her call is the only way the question gets answered
  // at all, and dropping it would put her back to inventing the figure.
  const { engine, messages } = harness();
  engine.handleServerMessage(toolCallMessage());
  const calls = messages.filter((m) => m.type === "tool_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "ask_the_assistant");
  assert.equal(calls[0].args.task, "Run the test suite.");
});

test("the next turn after a barge-in can delegate again", () => {
  // The suppression is one generation wide, not a switch that stays off. The
  // condemned turn speaks (silently, gated) and ends; the turn after it is a
  // new question and gets its hands back.
  const { engine, messages } = harness();
  engine.sendBargeIn();
  engine.handleServerMessage(AUDIO_MESSAGE);
  engine.handleServerMessage({ serverContent: { turnComplete: true } });
  engine.handleServerMessage(toolCallMessage("call-2"));
  const calls = messages.filter((m) => m.type === "tool_call");
  assert.equal(calls.length, 1, "the gate outlived the turn it was meant to condemn");
  assert.equal(calls[0].id, "call-2");
});

test("a dropped call is not left pending, so the turn still commits", () => {
  // `turnComplete` is held back while a call is outstanding. A call that was
  // never forwarded must therefore never have been tracked, or the suppressed
  // turn never closes and every later turn is read as its continuation.
  const { engine } = harness();
  engine.sendBargeIn();
  engine.handleServerMessage(toolCallMessage());
  assert.equal(engine.pendingToolCalls.size, 0);
});

// ─────────────────────────────────────────────── Google hangs up on its own

test("the resumption handle is kept, so a reconnect continues the conversation", () => {
  // Gemini ends a Live session on its own schedule. Before the handle was kept
  // the reconnect opened a session that had never heard of the conversation it
  // was replacing, mid-conversation, without saying so.
  const { engine } = harness();
  engine.handleServerMessage({ sessionResumptionUpdate: { newHandle: "handle-1", resumable: true } });
  assert.equal(engine.resumptionHandle, "handle-1");
  engine.handleServerMessage({ sessionResumptionUpdate: { newHandle: "handle-2", resumable: true } });
  assert.equal(engine.resumptionHandle, "handle-2", "only the newest handle is worth holding");
});

test("a handle the server says is not resumable is not kept", () => {
  // `resumable: false` means the server is mid generation: resuming from there
  // loses state, which is a worse lie than starting fresh.
  const { engine } = harness();
  engine.handleServerMessage({ sessionResumptionUpdate: { newHandle: "good", resumable: true } });
  engine.handleServerMessage({ sessionResumptionUpdate: { newHandle: "mid-generation", resumable: false } });
  assert.equal(engine.resumptionHandle, "good");
});

test("clearing the history drops the handle with it", () => {
  // Otherwise "forget that" reconnects straight back into the conversation it
  // was asked to forget.
  const { engine } = harness();
  engine.handleServerMessage({ sessionResumptionUpdate: { newHandle: "handle-1", resumable: true } });
  engine.explicitlyDisconnected = true; // keep `restartSession()` from dialling out of a test
  engine.sendClearHistory();
  assert.equal(engine.resumptionHandle, null);
});

test("goAway arms the replacement session before the socket dies", () => {
  // The 30-minute cap lands mid-demo or not at all. `goAway` is the only
  // warning, and reading it is the difference between a seam nobody notices
  // and a dead socket halfway through a sentence.
  const { engine } = harness();
  engine.handleServerMessage({ goAway: { timeLeft: "10s" } });
  assert.notEqual(engine.goAwayTimer, null, "the hang-up warning was read and ignored");
  engine.disconnect(); // clears the timer; nothing here may dial out
  assert.equal(engine.goAwayTimer, null);
});

test("the replacement is built a second early, and at once when Google does not say", () => {
  assert.equal(goAwayRestartDelayMs("10s"), 9000);
  assert.equal(goAwayRestartDelayMs("9.5s"), 8500);
  assert.equal(goAwayRestartDelayMs("0.4s"), 0, "less than the lead time means now");
  assert.equal(goAwayRestartDelayMs(undefined), 0, "no stated time means hanging up now");
  assert.equal(parseDurationMs("120s"), 120000);
  assert.equal(parseDurationMs("not a duration"), 0);
});

// ────────────────────────────────────────────── Google closes it, repeatedly

test("the retry ladder backs off and stops climbing at the cap", () => {
  // It was a flat 2000 ms with no cap and no end, and every retry mints a
  // single-use token: a Google-side outage spent quota every two seconds for
  // as long as the app stayed open.
  const ladder = [1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, RECONNECT_BASE_MS, RECONNECT_CAP_MS));
  assert.deepEqual(ladder, [1000, 2000, 4000, 8000, 15000, 15000]);
  assert.equal(backoffDelayMs(40, RECONNECT_BASE_MS, RECONNECT_CAP_MS), RECONNECT_CAP_MS, "2^40 ms is not a retry");
  assert.equal(backoffDelayMs(0, RECONNECT_BASE_MS, RECONNECT_CAP_MS), RECONNECT_BASE_MS);
});

test("a mint that failed is retried on the slower ladder", () => {
  // A round trip through the gateway and out to Google. Hammering it helps
  // nobody, and three minutes is the span a wifi drop actually occupies.
  const ladder = [1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, TOKEN_RETRY_BASE_MS, TOKEN_RETRY_CAP_MS));
  assert.deepEqual(ladder, [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.ok(TOKEN_RETRY_BASE_MS > RECONNECT_BASE_MS);
});

test("after the last attempt it stops and tells the operator", () => {
  // Silence is the worst option here: the lane is dead, nothing is coming, and
  // the operator is still talking to it.
  const { engine, notes, errors } = harness();
  engine.reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  engine.scheduleReconnect();
  assert.equal(engine.reconnectTimer, null, "it is still retrying after giving up");
  assert.deepEqual(notes, [RECONNECT_GAVE_UP_NOTE]);
  assert.equal(errors.length, 1, "giving up is exactly the kind of thing onError exists for");
  assert.match(notes[0], /microphone/i, "a dead end with no way back is not an operator-facing note");
});

test("a retry is armed on the way there, once per failure", () => {
  const { engine } = harness();
  engine.scheduleReconnect();
  assert.equal(engine.reconnectAttempts, 1);
  assert.notEqual(engine.reconnectTimer, null);
  engine.scheduleReconnect();
  assert.equal(engine.reconnectAttempts, 1, "a second failure while one retry is armed must not stack another");
  engine.disconnect();
  assert.equal(engine.reconnectTimer, null, "a deliberate stop leaves a timer running");
  assert.equal(engine.reconnectAttempts, 0);
});

// ──────────────────────────────────── no network at start, then wifi returns

test("a mint that can fix itself is retried; one that cannot is not", () => {
  // `mint-failed` was terminal for the whole session, so a laptop opened off
  // the network stayed voiceless after wifi came back until the app was
  // restarted.
  assert.ok(isRetryableTokenFailure("mint-failed"));
  assert.ok(isRetryableTokenFailure("gateway-unreachable"));
  assert.ok(isRetryableTokenFailure("gateway-error"));
  assert.ok(isRetryableTokenFailure("no-token"));
  // These want a key pasted, a reinstall or a billing cycle. A loop over them
  // only buries the sentence that says so.
  assert.equal(isRetryableTokenFailure("no-key"), false);
  assert.equal(isRetryableTokenFailure("sdk-unavailable"), false);
  assert.equal(isRetryableTokenFailure("quota"), false);
});

test("the slow ladder is the one a failed mint is put on", () => {
  // Which schedule a failure lands on is decided in `connect()`, one await
  // into a socketless code path; the arrangement is what is pinned.
  assert.match(
    engineSource,
    /if \(isRetryableTokenFailure\(result\.reason\)\) this\.scheduleReconnect\(true\);/,
    "a failed mint is back on the two-second loop, or back to being terminal",
  );
});

// ─────────────────────────────────────────── one breath, one turn

test("the end-of-turn wait is ours and adaptive, not Google's flat ceiling", () => {
  // "Open dukabot" — pause — "and run the tests" arrived as two turns at
  // 700 ms, so each half was routed on its own and the tests ran against a
  // project the first half had not finished opening. 1800 ms is still the
  // ceiling that stops that happening; what changed is that it is now only
  // the ceiling. The window closes at 600 ms on a sentence that sounds
  // finished, and the difference was measured: on a recorded utterance
  // against the live model over four alternating pairs, first audio
  // back came 992 ms sooner at the median, and every run of the new path
  // beat every run of the old one.
  assert.equal(END_OF_TURN_SILENCE_MS, DEFAULT_ENDPOINTER.maxSilenceMs);
  assert.equal(END_OF_TURN_SILENCE_MS, 1800, "the measured ceiling in turnTaking.ts has moved");
  assert.ok(END_OF_TURN_SILENCE_MS <= DEFAULT_ENDPOINTER.pacingCeilingMs);
  assert.ok(END_OF_TURN_SILENCE_MS > 1000, "600–1000 ms is a pause between phrases, not the end of a sentence");
  assert.match(
    engineSource,
    /automaticActivityDetection: \{ disabled: true \}/,
    "server VAD is back on, and with it a flat wait no measurement stands behind",
  );
  // Disabling it is only half the change. If these ever go missing the model
  // is told nothing about when he speaks, and the turn never ends at all.
  assert.match(engineSource, /sendRealtimeInput\(\{ activityStart: \{\} \}\)/);
  assert.match(engineSource, /sendRealtimeInput\(\{ activityEnd: \{\} \}\)/);
});

// ──────────────────────────────────── StrictMode, and sockets nobody wanted

test("a connect abandoned mid-flight opens nothing", () => {
  // React StrictMode mounts, unmounts and mounts again on every development
  // launch, and the stage builds a new engine each time. The first engine's
  // `connect()` is still in flight when its `disconnect()` runs, and its
  // socket used to finish opening a moment later: two live sessions, both
  // hearing the microphone, both answering, into one playback worklet.
  const afterMint = engineSource.indexOf("const result = await fetchGeminiLiveToken(");
  const mintGuard = engineSource.indexOf("if (this.explicitlyDisconnected) return;", afterMint);
  assert.ok(afterMint > 0 && mintGuard > afterMint, "nothing re-checks the flag after the token await");

  const afterOpen = engineSource.indexOf("session = await withTimeout(");
  const openGuard = engineSource.indexOf("if (this.explicitlyDisconnected) {", afterOpen);
  assert.ok(afterOpen > 0 && openGuard > afterOpen, "nothing re-checks the flag after the socket await");
  const closed = engineSource.indexOf("session.close();", openGuard);
  assert.ok(closed > openGuard && closed < openGuard + 400, "the abandoned socket is left open");
});

test("an abandoned attempt's callbacks are dead", () => {
  // The socket is closed, but its `onclose` still fires — and a stale
  // `onDisconnected` would report the live engine as disconnected, while a
  // stale `onmessage` would push the dead session's audio into the new one.
  const callbacks = engineSource.slice(engineSource.indexOf("callbacks: {"), engineSource.indexOf("let session: Session;"));
  for (const name of ["onopen", "onmessage", "onerror", "onclose"]) {
    const at = callbacks.indexOf(`${name}:`);
    assert.ok(at > 0, `${name} has gone`);
    const guard = callbacks.indexOf("if (abandoned) return;", at);
    assert.ok(guard > at && guard < at + 200, `${name} still runs for an abandoned session`);
  }
});

test("a socket that never opens is given up on rather than waited for", () => {
  // Cafe wifi with a captive portal: the connection is accepted and the
  // upgrade is never answered, so the promise stays pending, `connecting`
  // stays true for the life of the app, and the only way back is a restart.
  assert.ok(CONNECT_TIMEOUT_MS > 0 && CONNECT_TIMEOUT_MS <= 15000);
  assert.match(engineSource, /session = await withTimeout\(\s*pending,\s*CONNECT_TIMEOUT_MS,/);
  // And if it opens after we stopped waiting, it is closed rather than left
  // holding the microphone.
  assert.match(engineSource, /void pending\.then\(\s*\(late\) => \{/);
});

test("a socket that closed on the way up is not stored as the live one", () => {
  // An auth refusal arrives as a close, not as a throw, and it can land before
  // `connect()` has finished assigning the session. `onclose` has already
  // armed a retry by then; storing the dead session over it would make the
  // retry's own `if (this.session) return;` a wedge nothing recovers from.
  const assign = engineSource.indexOf("this.session = session;");
  const guard = engineSource.lastIndexOf("if (closedEarly) return;", assign);
  assert.ok(assign > 0 && guard > 0 && guard < assign);
  assert.match(engineSource, /closedEarly = true;/, "nothing records the early close any more");
});

test("the token fetch has a deadline too", () => {
  // The gateway reaches Google to mint; behind a portal that request answers
  // never, and this await is upstream of every other guard in `connect()`.
  assert.match(
    engineSource,
    /await fetchGeminiLiveToken\(AbortSignal\.timeout\(TOKEN_FETCH_TIMEOUT_MS\)\)/,
    "the mint can hang forever again",
  );
});

test("the session token mint cannot wedge every authenticated call", () => {
  // `GatewayClient.tokenPromise` is memoised, so one POST that never settles
  // is not a slow voice lane — it is the whole app waiting on a promise that
  // will not resolve, with nothing on screen to say so.
  const getToken = clientSource.slice(clientSource.indexOf("private static async getToken"), clientSource.indexOf("public static async request"));
  assert.match(getToken, /signal: AbortSignal\.timeout\(SESSION_TOKEN_TIMEOUT_MS\)/);
  assert.match(clientSource, /export const SESSION_TOKEN_TIMEOUT_MS = 8000;/);
  // The existing catch is what makes a timeout recoverable rather than sticky.
  assert.match(getToken, /this\.tokenPromise = null;/);
});

test("the gateway's own call to Google is bounded", () => {
  // The renderer's deadline only moves the wedge here: without one, the route
  // holds the request open and the next mint starts another.
  const mint = gatewaySource.slice(gatewaySource.indexOf("async function mintGeminiLiveToken"), gatewaySource.indexOf("function contentTypeIsJson"));
  assert.match(mint, /authTokens\.create\(/);
  assert.equal(
    (mint.match(/timeout: GEMINI_LIVE_MINT_TIMEOUT_MS/g) || []).length,
    2,
    "the client and the call each carry their own httpOptions; both need the deadline",
  );
  // And a deadline that ran out is reported as a network failure, not as a
  // rejected key — the one thing that is not broken.
  assert.match(mint, /error\?\.name === "AbortError" \|\| error\?\.name === "TimeoutError"/);
  assert.match(mint, /reason: "mint-failed"/);
});
