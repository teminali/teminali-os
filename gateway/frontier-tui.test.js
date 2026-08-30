import test from "node:test";
import assert from "node:assert/strict";
import { renderHeroBanner, renderInputCard, renderFooter } from "./frontier-tui.js";

test("renderHeroBanner produces centered Frontier Code pixel logo", () => {
  const banner = renderHeroBanner();
  assert.ok(typeof banner === "string");
  assert.ok(banner.includes("█▀▀"));
});

test("renderInputCard formats model, skill, and budget pills", () => {
  const card = renderInputCard({
    targetDir: "/Users/test/my-project",
    profile: "local",
    skill: "website-builder",
    budget: "0.50",
  });
  assert.ok(typeof card === "string");
  assert.ok(card.includes("Build"));
  assert.ok(card.includes("Devstral 24B"));
  assert.ok(card.includes("website-builder"));
});

test("renderFooter displays current working directory", () => {
  const footer = renderFooter({ targetDir: "/Users/test/my-project" });
  assert.ok(typeof footer === "string");
  assert.ok(footer.includes("my-project"));
});
