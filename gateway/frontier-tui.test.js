import test from "node:test";
import assert from "node:assert/strict";
import { renderBanner, renderStatusBar } from "./frontier-tui.js";

test("renderBanner produces styled Frontier Code header", () => {
  const banner = renderBanner();
  assert.ok(typeof banner === "string");
  assert.ok(banner.includes("███████╗"));
  assert.ok(banner.includes("The local-first, skill-native autonomous AI software engineering terminal."));
});

test("renderStatusBar formats directory, profile, skill, and budget", () => {
  const status = renderStatusBar({
    targetDir: "/Users/test/my-project",
    profile: "local",
    skill: "website-builder",
    budget: "0.50",
  });
  assert.ok(typeof status === "string");
  assert.ok(status.includes("my-project"));
  assert.ok(status.includes("local"));
  assert.ok(status.includes("website-builder"));
  assert.ok(status.includes("$0.50"));
});
