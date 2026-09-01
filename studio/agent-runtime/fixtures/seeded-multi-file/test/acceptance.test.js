import assert from "node:assert/strict";
import test from "node:test";
import { mean } from "../src/arithmetic.js";
import { summarize } from "../src/summary.js";

test("mean divides by the number of values", () => {
  assert.equal(mean([2, 4, 6]), 4);
});

test("summary uses the public label format", () => {
  assert.equal(summarize([2, 4, 6]), "Average: 4");
});
