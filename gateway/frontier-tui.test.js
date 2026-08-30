import test from "node:test";
import assert from "node:assert/strict";
import { renderHeroBanner, renderDashboardCards } from "./frontier-tui.js";

test("renderHeroBanner produces styled Frontier Code header", () => {
  const banner = renderHeroBanner();
  assert.ok(typeof banner === "string");
  assert.ok(banner.includes("███████╗"));
  assert.ok(banner.includes("Local-First Speed"));
  assert.ok(banner.includes("Skill-Native Specialist Roles"));
});

test("renderDashboardCards formats directory, profile, skill, and budget", () => {
  const status = renderDashboardCards({
    targetDir: "/Users/test/my-project",
    profile: "auto",
    skill: "website-builder",
    budget: "0.50",
  });
  assert.ok(typeof status === "string");
  assert.ok(status.includes("my-project"));
  assert.ok(status.includes("AUTO"));
  assert.ok(status.includes("website-builder"));
  assert.ok(status.includes("$0.50"));
  assert.ok(status.includes("ROUTING & INTELLIGENCE"));
});
