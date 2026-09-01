import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssPath = new URL("../src/index.css", import.meta.url);

test("overlay panels are positioned from the workspace, not an inherited grid cell", async () => {
  const css = await readFile(cssPath, "utf8");

  assert.match(
    css,
    /\.workspace\[data-layout="balanced"\]\s*>\s*\.explorer-panel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*inset:\s*0\s+auto\s+0\s+52px;/s,
  );
  assert.match(
    css,
    /\.workspace\[data-layout="compact"\]\s*>\s*\.explorer-panel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*inset:\s*0\s+auto\s+0\s+48px;/s,
  );
  assert.match(
    css,
    /\.workspace\[data-layout="compact"\]\s*>\s*\.assistant-panel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s,
  );
});
