import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SHEET_LIMITS, cellText, columnLabel, toGrid } from "../src/services/sheetPreview.ts";

/**
 * What a spreadsheet cell reads as, and how much of a sheet reaches the DOM.
 *
 * ExcelJS does the parsing; these pin the part that would otherwise render as
 * `[object Object]`, and the bound that stops a hundred-thousand-row sheet from
 * hanging the window.
 */

test("plain values read as themselves", () => {
  assert.equal(cellText("Ada"), "Ada");
  assert.equal(cellText(42), "42");
  assert.equal(cellText(0), "0");
  assert.equal(cellText(false), "false");
  assert.equal(cellText(null), "");
  assert.equal(cellText(undefined), "");
});

test("a formula cell shows its result, not its formula", () => {
  // A grid of `=SUM(B2:B9)` is not a view of the data.
  assert.equal(cellText({ formula: "SUM(B2:B9)", result: 118 }), "118");
  assert.equal(cellText({ sharedFormula: "A1", result: "yes" }), "yes");
});

test("a broken cell shows its error rather than looking empty", () => {
  assert.equal(cellText({ error: "#DIV/0!" }), "#DIV/0!");
});

test("rich text, hyperlinks and dates each have one reading", () => {
  assert.equal(cellText({ richText: [{ text: "bold" }, { text: " plain" }] }), "bold plain");
  assert.equal(cellText({ text: "Anthropic", hyperlink: "https://example.test" }), "Anthropic");
  assert.equal(cellText(new Date("2026-09-06T11:30:00Z")), "2026-09-06");
});

test("an unknown shape is blank, never [object Object]", () => {
  assert.equal(cellText({ unexpected: true }), "");
});

test("spreadsheet column lettering carries past Z", () => {
  assert.equal(columnLabel(1), "A");
  assert.equal(columnLabel(26), "Z");
  assert.equal(columnLabel(27), "AA");
  assert.equal(columnLabel(52), "AZ");
});

/** A worksheet of `rows[r][c]`, indexed from 1 the way ExcelJS is. */
function worksheet(name, rows, { rowCount, columnCount } = {}) {
  return {
    name,
    rowCount: rowCount ?? rows.length,
    columnCount: columnCount ?? Math.max(...rows.map((row) => row.length), 0),
    getRow: (index) => ({ getCell: (column) => ({ value: rows[index - 1]?.[column - 1] ?? null }) }),
  };
}

test("a small sheet comes through whole and is not marked truncated", () => {
  const grid = toGrid(worksheet("Q3", [["Item", "Cost"], ["Rope", 12]]));
  assert.deepEqual(grid.rows, [["Item", "Cost"], ["Rope", "12"]]);
  assert.equal(grid.name, "Q3");
  assert.equal(grid.truncated, false);
});

test("a sheet larger than the DOM budget is cut, and says by how much", () => {
  // The whole sheet can be a hundred thousand rows inside the same 8 MB file
  // cap; drawing that hangs the window, and dropping it quietly is worse.
  const grid = toGrid(worksheet("Big", [["a"]], { rowCount: 100_000, columnCount: 300 }));
  assert.equal(grid.rows.length, SHEET_LIMITS.maxRows);
  assert.equal(grid.rows[0].length, SHEET_LIMITS.maxColumns);
  assert.equal(grid.totalRows, 100_000);
  assert.equal(grid.totalColumns, 300);
  assert.equal(grid.truncated, true);
});

test("an empty sheet is a grid with no rows rather than a crash", () => {
  const grid = toGrid(worksheet("Blank", [], { rowCount: 0, columnCount: 0 }));
  assert.deepEqual(grid.rows, []);
  assert.equal(grid.truncated, false);
});

test("the parser is loaded on demand, never into the main bundle", async () => {
  // ExcelJS is close to a megabyte and the bundle already trips Vite's 500 kB
  // warning; a reader who never opens a spreadsheet must not pay for one.
  const source = await readFile(new URL("../src/components/workspace/panels/SheetPreview.tsx", import.meta.url), "utf8");
  assert.match(source, /import\("exceljs"\)/, "exceljs must be a dynamic import");
  assert.doesNotMatch(source, /^import .* from "exceljs"/m, "a static import would bundle it");
});

test("a legacy .xls is refused by name, with the conversion that fixes it", async () => {
  const source = await readFile(new URL("../src/components/workspace/panels/FilePane.tsx", import.meta.url), "utf8");
  assert.match(source, /application\/vnd\.ms-excel/);
  assert.match(source, /Save it as \.xlsx/);
});
