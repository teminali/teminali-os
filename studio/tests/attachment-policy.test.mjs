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

const chatDrawerPath = new URL("../src/components/chat/ChatDrawer.tsx", import.meta.url);
const aiServicePath = new URL("../src/services/aiService.ts", import.meta.url);

test("image attachments use a bounded dedicated local vision route", async () => {
  assert.equal(IMAGE_ATTACHMENTS_AVAILABLE, true);
  assert.equal(VISION_MODEL, "qwen3-vl:2b");
  assert.equal(MAX_IMAGE_ATTACHMENTS, 4);
  assert.equal(MAX_TOTAL_ATTACHMENT_BYTES, 5 * 1024 * 1024);
  assert.match(IMAGE_ATTACHMENT_HELP, /analyzes them locally/);
  assert.equal(dataUrlByteLength("data:image/png;base64,YWJj"), 3);

  const chatSource = await readFile(chatDrawerPath, "utf8");
  assert.match(chatSource, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(chatSource, /prepareImageAttachment/);
  assert.match(chatSource, /onPaste=/);
  assert.match(chatSource, /onDrop=/);

  const serviceSource = await readFile(aiServicePath, "utf8");
  assert.match(serviceSource, /frontier\.inspect_images/);
  assert.match(serviceSource, /GatewayClient\.request\("\/api\/ollama\/generate"/);
  assert.match(serviceSource, /payload\.response\?\.trim\(\)/);
  assert.match(serviceSource, /await unloadOllamaModel\(VISION_MODEL\)/);
  assert.match(serviceSource, /Local vision evidence:/);
  assert.match(serviceSource, /path="workspace\/relative\/path\.ext"/);
});
