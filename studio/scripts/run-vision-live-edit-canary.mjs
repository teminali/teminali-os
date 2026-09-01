import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANARY_HTML_PATH = "outputs/live-edit-vision-canary.html";
const SCREENSHOT_PNG_PATH = "outputs/canary-screenshot.png";
const INITIAL_HTML_CONTENT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Frontier Live Edit Canary</title>
</head>
<body>
  <main>Waiting for Frontier Live Edit.</main>
</body>
</html>
`;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkOllamaResidency() {
  const res = await fetch("http://127.0.0.1:11434/api/ps");
  const data = await res.json();
  const now = new Date();
  return (data.models || []).filter((m) => new Date(m.expires_at) > now);
}

async function main() {
  console.log("=== STEP 1: Setting up canary initial state ===");
  await writeFile(CANARY_HTML_PATH, INITIAL_HTML_CONTENT, "utf8");
  const initialModels = await checkOllamaResidency();
  assert.equal(initialModels.length, 0, `Ollama must have 0 resident models before test, found: ${JSON.stringify(initialModels)}`);
  console.log("Initial Ollama residency: 0 models.");

  const imageBuffer = await readFile(SCREENSHOT_PNG_PATH);
  const imageBase64 = imageBuffer.toString("base64");
  console.log(`Loaded screenshot fixture (${imageBuffer.length} bytes).`);

  console.log("=== STEP 2: Launching Chrome with CDP ===");
  const userDataDir = await mkdtemp(join(tmpdir(), "frontier-canary-"));
  const chromeProcess = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=9333",
      "--window-size=1280,900",
      "http://localhost:3000",
    ],
    { stdio: "ignore" }
  );

  let socket = null;
  const pending = new Map();
  let sequence = 0;

  function send(method, params = {}) {
    const id = ++sequence;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || "Evaluation failed");
    }
    return result.result.value;
  }

  try {
    let wsUrl = null;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch("http://127.0.0.1:9333/json");
        const list = await res.json();
        const page = list.find((item) => item.type === "page" && item.url.includes("localhost:3000"));
        if (page?.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await pause(250);
    }
    if (!wsUrl) throw new Error("Could not connect to Chrome CDP endpoint.");

    console.log(`Connecting to CDP at ${wsUrl}`);
    socket = new WebSocket(wsUrl);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        console.log(`[Browser Console] ${message.params.type}: ${text}`);
      }
      if (message.method === "Runtime.exceptionThrown") {
        console.log(`[Browser Exception]`, message.params.exceptionDetails?.text || message.params.exceptionDetails?.exception?.description);
      }
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });

    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("DOM.enable");

    console.log("=== STEP 3: Waiting for Studio UI to initialize ===");
    for (let i = 0; i < 40; i++) {
      const count = await evaluate(`document.querySelectorAll('.model-mode-picker button').length`);
      const hasTextarea = await evaluate(`Boolean(document.querySelector('textarea[aria-label="Ask Frontier Copilot"]'))`);
      if (count >= 2 && hasTextarea) break;
      await pause(300);
    }

    // Ensure Frontier Auto is selected
    await evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('.model-mode-picker button'));
      const autoBtn = buttons.find((b) => b.textContent.includes('Auto'));
      if (autoBtn) autoBtn.click();
    })()`);
    await pause(500);

    const activeProfile = await evaluate(`(() => {
      const selected = document.querySelector('.model-mode-picker button.selected')
        || Array.from(document.querySelectorAll('.model-mode-picker button')).find((b) => b.getAttribute('aria-checked') === 'true');
      return selected?.textContent || '';
    })()`);
    console.log(`Active mode: ${activeProfile}`);
    assert.ok(activeProfile.includes("Auto"), `Frontier Auto must be selected, got: "${activeProfile}"`);

    // Ensure outputs/live-edit-vision-canary.html is opened in the editor
    await evaluate(`(() => {
      window.__studioStore?.getState()?.openFile?.({
        path: "outputs/live-edit-vision-canary.html",
        name: "live-edit-vision-canary.html",
        content: ${JSON.stringify(INITIAL_HTML_CONTENT)}
      });
    })()`);
    await pause(500);

    console.log("=== STEP 4: Attaching image and submitting prompt ===");
    const promptText = `The attached screenshot shows a gateway routing error. Please resolve the issue for this canary by rewriting outputs/live-edit-vision-canary.html as a complete HTML document containing <div data-frontier-canary="vision-live-edit-ready">Frontier vision + Live Edit verified</div> and a brief note about the observed error. Use a fenced code block with path="outputs/live-edit-vision-canary.html".`;

    // Attach image via React store/DOM
    await evaluate(`(() => {
      const fileInput = document.querySelector('input[type="file"][accept*="image/png"]');
      if (!fileInput) throw new Error("File input not found");
      
      const byteCharacters = atob("${imageBase64}");
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: "image/png" });
      const file = new File([blob], "canary-screenshot.png", { type: "image/png" });
      
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);

    await pause(600);

    // Verify attachment in composer
    const attachmentsCount = await evaluate(`document.querySelectorAll('.composer-attachments img').length`);
    console.log(`Composer attached images count: ${attachmentsCount}`);
    assert.equal(attachmentsCount, 1, "One image must be attached in composer");

    // Focus textarea and use CDP Input.insertText for authentic typing
    await evaluate(`document.querySelector('textarea[aria-label="Ask Frontier Copilot"]')?.focus()`);
    await send("Input.insertText", { text: promptText });
    await pause(300);

    const textareaValue = await evaluate(`document.querySelector('textarea[aria-label="Ask Frontier Copilot"]')?.value || ''`);
    console.log(`Textarea populated length: ${textareaValue.length}`);
    assert.ok(textareaValue.length > 0, "Textarea must be populated with prompt");

    // Click Send
    const started = performance.now();
    console.log("Submitting prompt...");
    await evaluate(`document.querySelector('button.send')?.click()`);

    console.log("=== STEP 5: Observing Vision Analysis & Live Edit Execution ===");
    let visionCompleted = false;
    let streamingStarted = false;
    let liveEditSwitched = false;
    let generationFinished = false;

    for (let elapsed = 0; elapsed < 120; elapsed++) {
      await pause(1000);
      const state = await evaluate(`(() => {
        const toolCards = Array.from(document.querySelectorAll('.tool-call-card')).map(c => ({
          text: c.innerText,
          className: c.className
        }));
        const messages = Array.from(document.querySelectorAll('.copilot-message')).map(a => a.innerText);
        const activeTab = document.querySelector('.editor-tabs .tab.active')?.textContent || '';
        const editorText = window.monaco?.editor?.getModels()?.[0]?.getValue() || '';
        const isStreaming = Boolean(document.querySelector('button.stop') || document.querySelector('.stream-caret'));
        const dispatchNote = document.querySelector('.dispatch-note')?.textContent || '';
        const previewIframe = document.querySelector('iframe[title$="preview"]');
        const previewContent = previewIframe ? (previewIframe.contentDocument?.body?.innerText || '') : '';
        return {
          toolCards,
          messagesCount: messages.length,
          messages,
          activeTab,
          editorLines: editorText.split('\\n').length,
          editorHasTarget: editorText.includes('vision-live-edit-ready'),
          isStreaming,
          dispatchNote,
          previewContent
        };
      })()`);

      if (state.toolCards.length > 0 && !visionCompleted) {
        console.log(`[${Math.round((performance.now() - started) / 1000)}s] Tool cards observed:`, state.toolCards);
        const done = state.toolCards.some(t => t.text.includes('Analyzed') || t.text.includes('completed') || t.className.includes('completed'));
        if (done) visionCompleted = true;
      }

      if (state.isStreaming && !streamingStarted) {
        streamingStarted = true;
        console.log(`[${Math.round((performance.now() - started) / 1000)}s] Streaming started... Dispatch note: "${state.dispatchNote}"`);
      }

      if (state.editorHasTarget && !liveEditSwitched) {
        liveEditSwitched = true;
        console.log(`[${Math.round((performance.now() - started) / 1000)}s] Monaco live edit target detected in editor! Active tab: "${state.activeTab}", lines: ${state.editorLines}`);
      }

      if (streamingStarted && !state.isStreaming) {
        generationFinished = true;
        console.log(`[${Math.round((performance.now() - started) / 1000)}s] Generation finished. Messages count: ${state.messagesCount}`);
        break;
      }
    }

    assert.ok(generationFinished, "Generation should finish within timeout");

    // Wait a moment for Live Edit commit settlement
    await pause(3000);

    console.log("=== STEP 6: Verifying Disk File & Acceptance Criteria ===");
    const diskContent = await readFile(CANARY_HTML_PATH, "utf8");
    console.log("File content on disk:\n", diskContent);

    // Get conversation text
    const allMessagesText = await evaluate(`document.querySelector('.copilot-scroll')?.innerText || Array.from(document.querySelectorAll('.copilot-message')).map(e => e.innerText).join('\\n')`);
    console.log("Copilot conversation text:\n", allMessagesText);

    // Assert 1: Screenshot evidence contains exact visible message
    assert.match(allMessagesText, /No gateway route matches this request/i, "Screenshot evidence must ground the exact visible error message");

    // Assert 2: Output is complete fenced HTML file with explicit path
    assert.match(allMessagesText, /path=["']?outputs\/live-edit-vision-canary\.html["']?/, "Output must contain explicit path");

    // Assert 3: File contains canary data attribute and visible text
    assert.match(diskContent, /data-frontier-canary=["']vision-live-edit-ready["']/, "File must contain data-frontier-canary='vision-live-edit-ready'");
    assert.match(diskContent, /Frontier vision \+ Live Edit verified/, "File must contain visible text 'Frontier vision + Live Edit verified'");

    // Assert 4: Composer returns to idle
    const isComposerIdle = await evaluate(`Boolean(document.querySelector('button.send') && !document.querySelector('button.stop'))`);
    assert.ok(isComposerIdle, "Composer must return to idle state");

    // Assert 5: Ollama residency is empty afterward
    const finalModels = await checkOllamaResidency();
    console.log("Final Ollama residency:", finalModels);
    assert.equal(finalModels.length, 0, `Ollama residency must be empty after canary, found: ${JSON.stringify(finalModels)}`);

    const totalDurationSec = (performance.now() - started) / 1000;
    console.log(`\n*** CANARY PASSED in ${totalDurationSec.toFixed(2)}s ***\n`);
  } finally {
    if (socket) socket.close();
    chromeProcess.kill("SIGTERM");
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("CANARY FAILED:", err);
  process.exit(1);
});
