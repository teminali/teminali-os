import assert from "node:assert/strict";
import test from "node:test";
import { mean, sum } from "../src/arithmetic.js";

test("sum retains positive, negative, and empty-array behavior", () => {
  assert.equal(sum([2, -1, 4]), 5);
  assert.equal(sum([]), 0);
});

test("mean retains its empty-array behavior", () => {
  assert.equal(mean([]), 0);
});
