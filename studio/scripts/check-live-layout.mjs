import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const wsUrl = process.argv[2];
const screenshotPath = process.argv[3];
if (!wsUrl || !screenshotPath) {
  throw new Error("Usage: node scripts/check-live-layout.mjs <page-websocket-url> <screenshot-path>");
}

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
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function wait(ms) {
  await evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`);
}

async function setViewport(width, height) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 900));
}

async function openExplorer() {
  await evaluate(`(() => {
    if (document.querySelector('.explorer-panel')) return true;
    const button = document.querySelector('button[aria-label="Files"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await wait(150);
}

async function geometry() {
  return evaluate(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, right: box.right, width: box.width };
    };
    const workspace = document.querySelector('.workspace');
    return {
      layout: workspace?.dataset.layout,
      activity: rect('.activity-rail'),
      explorer: rect('.explorer-panel'),
      editor: rect('.editor-area'),
      explorerColumn: getComputedStyle(document.querySelector('.explorer-panel')).gridColumn,
      explorerZ: getComputedStyle(document.querySelector('.explorer-panel')).zIndex,
    };
  })()`);
}

function assertAligned(result, expectedLayout) {
  assert.equal(result.layout, expectedLayout);
  assert.ok(result.activity && result.explorer && result.editor);
  assert.ok(result.explorer.width >= 176, "Explorer must be visibly open");
  assert.ok(
    Math.abs(result.explorer.x - result.activity.right) <= 0.5,
    `Explorer x=${result.explorer.x} must align with activity edge=${result.activity.right}`,
  );
  assert.equal(result.explorerColumn, "1 / -1");
  assert.equal(result.explorerZ, "30");
}

await send("Page.enable");
await send("Runtime.enable");

await setViewport(1100, 900);
await openExplorer();
const balanced = await geometry();
assertAligned(balanced, "balanced");

const image = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
await writeFile(screenshotPath, Buffer.from(image.data, "base64"));

await setViewport(760, 900);
await openExplorer();
const compact = await geometry();
assertAligned(compact, "compact");

socket.close();
console.log(JSON.stringify({ balanced, compact, screenshotPath }, null, 2));
