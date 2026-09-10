// Regression guard for the streaming transcript in static/app.js.
//
// Three symptoms shipped together and shared one cause: the reveal loop rebuilt
// el.innerHTML on every animation frame, so every .spoken-word span was destroyed
// and recreated 60 times a second. With `animation-fill-mode: both` a fresh span
// sits at opacity 0, so no word ever got past the first frame of its fade-in --
// the whole transcript stayed invisible until she stopped talking. The same
// rebuild re-emitted the caret, and the loop read `streamingAssistantEl`, which is
// nulled when the final answer lands, so the loop died mid-turn and left that
// caret blinking on a finished message.
//
// Run: node code/test_reveal.mjs

// Headless guard for the streaming-transcript reveal. Stubs just enough DOM to drive
// UIController.startSpeechSync deterministically, one animation frame at a time.
import fs from "node:fs";
import vm from "node:vm";

class Node {
  constructor(tag) { this.tag = tag; this.className = ""; this.children = []; this._text = ""; this.parentNode = null; }
  get isConnected() { return this.parentNode !== null || this._root === true; }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
  insertBefore(n, ref) {
    n.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
    }
    this.parentNode = null;
  }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join("") : this._text; }
  set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = v; }
  querySelectorAll(sel) {
    const cls = sel.split(/\s+/).pop().replace(/^\./, "").replace(/:not\(.*\)$/, "");
    const out = [];
    (function walk(n) { for (const c of n.children) { if ((c.className || "").split(/\s+/).includes(cls)) out.push(c); walk(c); } })(this);
    return out;
  }
}

let frames = [];
const sandbox = {
  window: { addEventListener() {} },
  document: { createElement: (t) => new Node(t) },
  requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
  cancelAnimationFrame: (id) => { frames = []; },
  performance: { now: () => Date.now() },
  console, setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
const src = fs.readFileSync(new URL("./static/app.js", import.meta.url), "utf8");
vm.createContext(sandbox);
vm.runInContext(src + "\n;globalThis.__UIController = UIController;", sandbox);
const UIController = sandbox.__UIController;

function flush() { const q = frames; frames = []; q.forEach(cb => cb()); }

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  PASS  " : "  FAIL  ") + msg); if (!cond) fails++; };

function makeUI() {
  const ui = Object.create(UIController.prototype);
  ui.audio = { spoken: 0, isTTSPlaying: false, getSpokenSeconds() { return this.spoken; } };
  ui.messagesContainer = new Node("div"); ui.messagesContainer._root = true;
  ui.scrollToBottom = () => {};
  ui.wordsPerSecond = 3.0;
  ui.speechSyncFrame = null;
  ui.revealEl = null; ui.revealHostEl = null; ui.revealNodes = []; ui.revealCursor = null;
  ui.lastRevealCount = -1; ui.lastRevealAt = 0;
  ui.assistantFullText = ""; ui.pendingFinalText = null;
  ui.streamingAssistantEl = null;
  return ui;
}
function newBlock(ui) {
  const block = new Node("div"); block.className = "assistant-turn-block";
  const el = new Node("div"); el.className = "assistant-text";
  block.appendChild(el); ui.messagesContainer.appendChild(block);
  return el;
}

// ---- A. words are appended, never recreated (the invisible-text regression) -------
console.log("\nA. incremental reveal keeps existing word nodes");
{
  const ui = makeUI();
  const el = newBlock(ui);
  ui.assistantFullText = "one two three four five";
  ui.audio.isTTSPlaying = true; ui.audio.spoken = 0.34;   // ~2 words
  // Identity is read off the DOM, not off revealNodes, so the assertion means the
  // same thing for any implementation: did these word nodes survive the next frame?
  const wordSpans = () => el.children.filter(c => (c.className || "").includes("spoken-word"));
  ui.startSpeechSync(el);
  flush();
  const after1 = wordSpans();
  ok(after1.length === 2, `two words on screen at 0.34s (got ${after1.length})`);
  ui.audio.spoken = 1.0;                                   // ~4 words
  flush();
  const after2 = wordSpans();
  ok(after2.length === 4, `four words on screen at 1.0s (got ${after2.length})`);
  ok(after1.length > 0 && after2[0] === after1[0] && after2[1] === after1[1],
     "the first two word nodes are the SAME DOM nodes (fade-in not restarted)");
  ok(el.children[el.children.length - 1] === ui.revealCursor, "caret is the last child");
  ok(el.textContent === "one two three four", `text reads '${el.textContent}'`);
}

// ---- B. a partial answer that cuts a word in half --------------------------------
console.log("\nB. half-streamed word is reconciled, not duplicated");
{
  const ui = makeUI();
  const el = newBlock(ui);
  ui.assistantFullText = "hel";
  ui.audio.isTTSPlaying = true; ui.audio.spoken = 0.34;
  ui.startSpeechSync(el); flush();
  ok(ui.revealNodes.length === 1 && ui.revealNodes[0].textContent === "hel", "shows 'hel'");
  const firstNode = ui.revealNodes[0];
  ui.assistantFullText = "hello world";
  flush();
  ok(ui.revealNodes[0] === firstNode, "same node reused for the completed word");
  ok(el.textContent === "hello world", `text reads '${el.textContent}'`);
}

// ---- C. finishing the turn always takes the caret with it ------------------------
console.log("\nC. the caret never outlives its turn");
{
  const ui = makeUI();
  const el = newBlock(ui);
  ui.assistantFullText = "alpha beta gamma";
  ui.audio.isTTSPlaying = true; ui.audio.spoken = 0.34;
  ui.startSpeechSync(el); flush();
  ok(el.querySelectorAll(".assistant-streaming-cursor").length === 1, "caret present while speaking");

  // the exact sequence that stranded it: final answer arrives, streamingAssistantEl
  // is nulled, then playback stops.
  ui.pendingFinalText = "alpha beta gamma";
  ui.streamingAssistantEl = null;
  ui.audio.isTTSPlaying = false; ui.audio.spoken = 1.1;
  ui.completeAssistantText();
  ok(el.querySelectorAll(".assistant-streaming-cursor").length === 0, "caret gone after the turn completes");
  ok(el.textContent === "alpha beta gamma", `full text on screen: '${el.textContent}'`);
  ok(ui.revealEl === null, "reveal released");
}

// ---- D. playback stops before the final answer lands ------------------------------
console.log("\nD. playback ends with no final text: caret still goes");
{
  const ui = makeUI();
  const el = newBlock(ui);
  ui.assistantFullText = "one two three four";
  ui.audio.isTTSPlaying = true; ui.audio.spoken = 0.34;
  ui.startSpeechSync(el); flush();
  ui.pendingFinalText = null;                 // final_assistant_answer has not arrived
  ui.audio.isTTSPlaying = false;
  ui.completeAssistantText();
  ok(el.querySelectorAll(".assistant-streaming-cursor").length === 0, "caret gone");
  ok(ui.revealNodes.length === 2, "revealed words survive for the turn to resume");
}

// ---- E. nothing is revealed before she speaks -------------------------------------
console.log("\nE. transcript stays empty until the voice starts");
{
  const ui = makeUI();
  const el = newBlock(ui);
  ui.assistantFullText = "these words must not appear yet";
  ui.audio.isTTSPlaying = false; ui.audio.spoken = 0;
  ui.startSpeechSync(el);
  ui.lastRevealAt = performance.now() - 5000;   // well past the stall window
  flush(); flush();
  ok(el.textContent === "", `nothing revealed (got '${el.textContent}')`);
}

// ---- F. a stray caret from an earlier turn is swept -------------------------------
console.log("\nF. stray caret on an old message is swept when a new turn opens");
{
  const ui = makeUI();
  const oldEl = newBlock(ui);
  const stray = new Node("span"); stray.className = "assistant-streaming-cursor";
  oldEl.appendChild(stray);
  ui.clearStreamingCursor();
  ok(oldEl.querySelectorAll(".assistant-streaming-cursor").length === 0, "stray caret removed");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
