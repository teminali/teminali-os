import assert from "node:assert/strict";
import test from "node:test";
import siteData from "../src/site-data.json" with { type: "json" };
import { renderPricing } from "../src/app.js";

test("site-data contains required verified metrics and pricing tiers", () => {
  assert.equal(siteData.brand.name, "DevStream");
  assert.equal(siteData.brand.verifiedMetrics.length, 3);
  assert.equal(siteData.pricing.monthly.length, 3);
  assert.equal(siteData.pricing.annual.length, 3);
});

test("renderPricing correctly formats monthly and annual tiers", () => {
  const container = { innerHTML: "" };
  renderPricing(container, false);
  assert.ok(container.innerHTML.includes("$49/mo"));

  renderPricing(container, true);
  assert.ok(container.innerHTML.includes("$39/mo"));
});
