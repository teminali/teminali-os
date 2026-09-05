/**
 * Turning a workbook into something the file pane can draw.
 *
 * The parsing itself belongs to ExcelJS; what lives here is everything that
 * would otherwise be untestable inside a component — what a cell's *value* is
 * once it stops being a formula, a hyperlink or a run of rich text, and how
 * much of a sheet is safe to put in the DOM.
 *
 * ExcelJS reads OOXML only. A legacy `.xls` is BIFF, a different format
 * entirely, and the pane says so rather than rendering an empty grid; the one
 * `.xls` that does open is the one that was never a spreadsheet — the HTML
 * table many web apps export under that name — which `server/workspace.js`
 * already sniffs and returns as text.
 */

/**
 * A sheet is drawn, not streamed, so it has to fit in the DOM.
 *
 * 200 × 50 is ten thousand cells, which renders instantly; the whole sheet
 * could be a hundred thousand rows inside the same 8 MB file cap, and drawing
 * that would hang the window. What is cut is stated on screen rather than
 * silently dropped — a viewer that quietly shows you two thirds of your data
 * is worse than one that refuses.
 */
export const SHEET_LIMITS = Object.freeze({ maxRows: 200, maxColumns: 50 });

export interface SheetGrid {
  name: string;
  rows: string[][];
  /** What the sheet actually holds, so the pane can say what it left out. */
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
}

/** The shape this module needs from an ExcelJS worksheet. Narrow, so a test can stand in for one. */
export interface WorksheetLike {
  name?: string;
  rowCount?: number;
  columnCount?: number;
  getRow: (index: number) => { getCell: (index: number) => { value: unknown } } | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * What a cell reads as.
 *
 * A formula cell carries both the formula and its last computed result, and it
 * is the result a reader wants — a grid of `=SUM(B2:B9)` is not a view of the
 * data. Everything else here is ExcelJS's own value shapes, each of which
 * would otherwise render as `[object Object]`.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (!isObject(value)) return "";

  // `#DIV/0!` and its kin: the error is the value, and hiding it would make a
  // broken sheet look like an empty one.
  if (typeof value.error === "string") return value.error;
  if ("result" in value) return cellText(value.result);
  if (Array.isArray(value.richText)) {
    return value.richText.map((run) => (isObject(run) && typeof run.text === "string" ? run.text : "")).join("");
  }
  if (typeof value.text === "string") return value.text;
  if (typeof value.hyperlink === "string") return value.hyperlink;
  return "";
}

/** One worksheet as a bounded grid of strings, plus what was left out of it. */
export function toGrid(worksheet: WorksheetLike, limits = SHEET_LIMITS): SheetGrid {
  const totalRows = Math.max(0, worksheet.rowCount ?? 0);
  const totalColumns = Math.max(0, worksheet.columnCount ?? 0);
  const rowCount = Math.min(totalRows, limits.maxRows);
  const columnCount = Math.min(totalColumns, limits.maxColumns);

  const rows: string[][] = [];
  for (let row = 1; row <= rowCount; row += 1) {
    const source = worksheet.getRow(row);
    const cells: string[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      cells.push(source ? cellText(source.getCell(column)?.value) : "");
    }
    rows.push(cells);
  }

  return {
    name: worksheet.name || "Sheet",
    rows,
    totalRows,
    totalColumns,
    truncated: totalRows > rowCount || totalColumns > columnCount,
  };
}

/** Spreadsheet-column lettering: 1 → A, 27 → AA. The header a reader expects. */
export function columnLabel(index: number): string {
  let label = "";
  let remaining = index;
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    label = String.fromCharCode(65 + digit) + label;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return label;
}
