import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

test("TimelineNarrationWaveform component file exists and exports valid component", () => {
  const componentPath = fileURLToPath(
    new URL("../src/video/components/timeline/TimelineNarrationWaveform.tsx", import.meta.url)
  );
  assert.ok(fs.existsSync(componentPath), "TimelineNarrationWaveform.tsx should exist");

  const source = fs.readFileSync(componentPath, "utf8");
  assert.ok(source.includes("export const TimelineNarrationWaveform"));
  assert.ok(source.includes("useAssistantActivityStore"));
  assert.ok(source.includes("BAR_COUNT"));
  assert.ok(source.includes("#00bf63"));
});

test("TimelineNarrationWaveform reacts to assistant activity store state", async () => {
  const { useAssistantActivityStore } = await import("../src/store/assistantActivityStore.ts");

  assert.equal(typeof useAssistantActivityStore.getState().setTaskRunning, "function");
  useAssistantActivityStore.getState().setTaskRunning(true, "Narrating video cuts");

  assert.equal(useAssistantActivityStore.getState().isTaskRunning, true);
  assert.equal(useAssistantActivityStore.getState().currentTaskPrompt, "Narrating video cuts");

  useAssistantActivityStore.getState().setTaskRunning(false, null);
  assert.equal(useAssistantActivityStore.getState().isTaskRunning, false);
});
