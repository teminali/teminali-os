import test from "node:test";
import assert from "node:assert/strict";

import { subtract } from "./calculator.js";

test("subtracts the second number from the first", () => {
  assert.equal(subtract(9, 4), 5);
});
