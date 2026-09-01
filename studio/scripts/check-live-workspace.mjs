import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const wsUrl = process.argv[2];
const screenshotPath = process.argv[3];
if (!wsUrl || !screenshotPath) throw new Error("Usage: node scripts/check-live-workspace.mjs <page-websocket-url> <screenshot-path>");

const socket = new WebSocket(wsUrl);
const pending = new Map();
let sequence = 0;
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
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

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.reload", { ignoreCache: true });
await pause(1_000);

await evaluate(`(() => {
  if (!document.querySelector('.explorer-panel')) document.querySelector('button[aria-label="Files"]')?.click();
})()`);
await pause(600);

const explorer = await evaluate(`(() => ({
  body: document.body.innerText,
  countText: document.querySelector('.workspace-count')?.textContent || document.querySelector('.sidebar-count')?.textContent || '',
  rootText: document.querySelector('.explorer-panel')?.innerText || '',
  studioIndex: Boolean(document.querySelector('button[title="studio/index.html"]')),
}))()`);
assert.ok(!explorer.body.includes("No gateway route matches this request."), "stale gateway route error must be absent");
assert.ok(explorer.rootText.includes("benchmarks") && explorer.rootText.includes("studio"), "real workspace roots must be visible");
assert.ok(explorer.studioIndex, "the real studio/index.html file must be present");

await evaluate(`document.querySelector('button[title="studio/index.html"]').click()`);
await pause(500);
await evaluate(`Array.from(document.querySelectorAll('.mode-switch button')).find((button) => button.textContent.trim() === 'Preview').click()`);
await pause(500);

const filePreview = await evaluate(`(() => ({
  modeLabels: Array.from(document.querySelectorAll('.mode-switch button')).map((button) => button.textContent.trim()),
  hasPreview: Boolean(document.querySelector('.preview-surface')),
  hasHtmlFrame: Boolean(document.querySelector('iframe[title$="preview"]')),
  surfaces: Array.from(document.querySelectorAll('.preview-surface-switch button')).map((button) => button.textContent.trim()),
}))()`);
assert.deepEqual(filePreview.modeLabels, ["Preview", "Code"]);
assert.ok(filePreview.hasPreview && filePreview.hasHtmlFrame, "real HTML file preview must render in a sandboxed iframe");
assert.deepEqual(filePreview.surfaces, ["File Preview", "Browser"]);

await evaluate(`Array.from(document.querySelectorAll('.preview-surface-switch button')).find((button) => button.textContent.includes('Browser')).click()`);
await pause(300);
const browser = await evaluate(`(() => ({
  hasFrame: Boolean(document.querySelector('iframe[title="Frontier Browser"]')),
  hasAddress: Boolean(document.querySelector('input[aria-label="Browser address"]')),
  address: document.querySelector('input[aria-label="Browser address"]')?.value || '',
}))()`);
assert.ok(browser.hasFrame && browser.hasAddress, "embedded Browser controls and frame must be wired");
assert.equal(browser.address, "/preview/frontier-hypercar.html", "Browser must open a real checked-in local preview by default");

const image = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
await writeFile(screenshotPath, Buffer.from(image.data, "base64"));
socket.close();
console.log(JSON.stringify({ explorer, filePreview, browser, screenshotPath }, null, 2));
