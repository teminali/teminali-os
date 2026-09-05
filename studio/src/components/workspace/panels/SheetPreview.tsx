import React, { useEffect, useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { EmptyState } from "../../ui";
import { SHEET_LIMITS, columnLabel, toGrid, type SheetGrid } from "../../../services/sheetPreview";

/**
 * A workbook, drawn.
 *
 * ExcelJS is imported *dynamically* and nothing else imports it: it is close to
 * a megabyte, the bundle already trips Vite's 500 kB warning, and a reader who
 * never opens a spreadsheet should never pay for one. That also means the first
 * sheet of a session shows a spinner while the chunk arrives, which is why the
 * loading state is a real state rather than a flash.
 *
 * The bytes are already in the pane as a blob URL, so they are fetched back out
 * of it rather than decoded from base64 a second time.
 */
export const SheetPreview: React.FC<{ url: string }> = ({ url }) => {
  const [sheets, setSheets] = useState<SheetGrid[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setError(null);
    setActive(0);

    (async () => {
      try {
        const [module, buffer] = await Promise.all([
          import("exceljs"),
          fetch(url).then((response) => response.arrayBuffer()),
        ]);
        const Workbook = (module as unknown as { Workbook: new () => never }).Workbook
          ?? (module as unknown as { default: { Workbook: new () => never } }).default.Workbook;
        const workbook = new Workbook() as unknown as {
          xlsx: { load: (data: ArrayBuffer) => Promise<unknown> };
          worksheets: Parameters<typeof toGrid>[0][];
        };
        await workbook.xlsx.load(buffer);
        if (cancelled) return;
        const grids = workbook.worksheets.map((worksheet) => toGrid(worksheet));
        setSheets(grids.length ? grids : []);
      } catch (failure) {
        if (!cancelled) setError((failure as Error).message || "The workbook could not be read.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={26} strokeWidth={1.6} />}
        title="This workbook could not be read"
        detail={error}
      />
    );
  }

  if (!sheets) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  if (!sheets.length) return <EmptyState title="This workbook has no sheets" />;

  const grid = sheets[Math.min(active, sheets.length - 1)];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="border-collapse text-2xs font-mono">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 bg-surface-sunken border border-edge-chrome px-2 py-1 text-ink-disabled font-normal" />
              {(grid.rows[0] ?? []).map((_, column) => (
                <th
                  key={column}
                  className="sticky top-0 z-10 bg-surface-sunken border border-edge-chrome px-2 py-1 text-ink-disabled font-normal text-left"
                >
                  {columnLabel(column + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, index) => (
              <tr key={index}>
                <th className="sticky left-0 z-10 bg-surface-sunken border border-edge-chrome px-2 py-1 text-ink-disabled font-normal text-right">
                  {index + 1}
                </th>
                {row.map((cell, column) => (
                  <td key={column} className="border border-edge-chrome px-2 py-1 text-ink-prose whitespace-nowrap max-w-[24rem] truncate">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="h-8 flex-shrink-0 flex items-center gap-1 px-3 border-t border-edge-chrome overflow-x-auto">
        {sheets.map((sheet, index) => (
          <button
            key={`${sheet.name}-${index}`}
            type="button"
            onClick={() => setActive(index)}
            className={`px-2 py-0.5 rounded text-2xs whitespace-nowrap ${
              index === active ? "bg-surface-chip text-ink-high" : "text-ink-muted hover:text-ink-high"
            }`}
          >
            {sheet.name}
          </button>
        ))}
        <div className="flex-1" />
        {/* What was cut is said, not silently dropped. */}
        {grid.truncated && (
          <span className="text-2xs text-ink-disabled whitespace-nowrap">
            showing {Math.min(grid.totalRows, SHEET_LIMITS.maxRows)} of {grid.totalRows} rows
            {grid.totalColumns > SHEET_LIMITS.maxColumns && `, ${SHEET_LIMITS.maxColumns} of ${grid.totalColumns} columns`}
          </span>
        )}
      </div>
    </div>
  );
};
