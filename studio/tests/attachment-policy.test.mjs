import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  dataUrlByteLength,
  IMAGE_ATTACHMENT_HELP,
  IMAGE_ATTACHMENTS_AVAILABLE,
  MAX_IMAGE_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  VISION_MODEL,
} from "../src/services/attachmentPolicy.ts";

const composerPath = new URL("../src/components/chat/Composer.tsx", import.meta.url);
const attachmentsHookPath = new URL("../src/hooks/useAttachments.ts", import.meta.url);
// The local vision route lives in the model engine, not the host adapter.
const enginePath = new URL("../src/services/frontierEngine.ts", import.meta.url);

test("image attachments use a bounded dedicated local vision route", async () => {
  assert.equal(IMAGE_ATTACHMENTS_AVAILABLE, true);
  assert.equal(VISION_MODEL, "qwen3-vl:2b");
  assert.equal(MAX_IMAGE_ATTACHMENTS, 4);
  assert.equal(MAX_TOTAL_ATTACHMENT_BYTES, 5 * 1024 * 1024);
  assert.match(IMAGE_ATTACHMENT_HELP, /analyzes them locally/);
  assert.equal(dataUrlByteLength("data:image/png;base64,YWJj"), 3);

  // The intake moved off the old chat drawer onto the composer and its hook,
  // which is what every chat surface now shares. The contract is the same:
  // paste, drop, and a bounded reader that never silently accepts more.
  const composerSource = await readFile(composerPath, "utf8");
  assert.match(composerSource, /onPaste=/);
  assert.match(composerSource, /attachments\?\.dropProps/);
  assert.match(composerSource, /filesFromClipboard/);

  const intakeSource = await readFile(attachmentsHookPath, "utf8");
  assert.match(intakeSource, /onDrop:/);
  // The intake is bounded on count and on per-file size before anything is read.
  assert.match(intakeSource, /MAX_ATTACHMENTS/);
  assert.match(intakeSource, /MAX_FILE_BYTES/);

  const serviceSource = await readFile(enginePath, "utf8");
  assert.match(serviceSource, /frontier\.inspect_images/);
  assert.match(serviceSource, /GatewayClient\.request\("\/api\/ollama\/generate"/);
  assert.match(serviceSource, /payload\.response\?\.trim\(\)/);
  assert.match(serviceSource, /await unloadOllamaModel\(VISION_MODEL\)/);
  assert.match(serviceSource, /Local vision evidence:/);
  assert.match(serviceSource, /path="workspace\/relative\/path\.ext"/);
});
