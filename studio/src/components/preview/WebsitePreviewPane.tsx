import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, FileSearch, Globe2, LoaderCircle, RefreshCw, Square, Layers, Sliders, X } from "lucide-react";
import type { EditorTab } from "../../types";
import { LiveEditService } from "../../services/liveEditService";
import { useStudioStore } from "../../store/studioStore";

type PreviewSurface = "file" | "browser";
type SheetState = { status: "idle" | "loading" | "ready" | "error"; rows: string[][]; sheetName: string; error?: string };

function base64Bytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function csvRows(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"' && quoted && input[index + 1] === '"') { cell += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += character;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.slice(0, 2_000).map((columns) => columns.slice(0, 200));
}

function spreadsheetXmlRows(xml: string) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("The spreadsheet XML is malformed.");
  return Array.from(document.getElementsByTagName("Row")).slice(0, 2_000).map((row) =>
    Array.from(row.getElementsByTagName("Cell")).slice(0, 200).map((cell) => cell.textContent?.trim() || ""),
  );
}

function columnIndex(reference: string) {
  const letters = reference.replace(/\d+/g, "").toUpperCase();
  return letters.split("").reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0) - 1;
}

async function xlsxRows(base64: string) {
  const { default: JSZip } = await import("jszip");
  const archive = await JSZip.loadAsync(base64Bytes(base64));
  const sharedXml = await archive.file("xl/sharedStrings.xml")?.async("string");
  const shared = sharedXml ? Array.from(new DOMParser().parseFromString(sharedXml, "application/xml").getElementsByTagName("si")).map((node) => node.textContent || "") : [];
  const workbookXml = await archive.file("xl/workbook.xml")?.async("string");
  const sheetName = workbookXml ? new DOMParser().parseFromString(workbookXml, "application/xml").getElementsByTagName("sheet")[0]?.getAttribute("name") || "Sheet 1" : "Sheet 1";
  const sheetEntry = Object.keys(archive.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0];
  if (!sheetEntry) throw new Error("The workbook does not contain a readable worksheet.");
  const sheetXml = await archive.file(sheetEntry)?.async("string");
  if (!sheetXml) throw new Error("The worksheet could not be read.");
  const document = new DOMParser().parseFromString(sheetXml, "application/xml");
  const rows = Array.from(document.getElementsByTagName("row")).slice(0, 2_000).map((row) => {
    const result: string[] = [];
    for (const cell of Array.from(row.getElementsByTagName("c")).slice(0, 200)) {
      const index = columnIndex(cell.getAttribute("r") || "A1");
      const raw = cell.getElementsByTagName("v")[0]?.textContent || cell.getElementsByTagName("t")[0]?.textContent || "";
      result[index] = cell.getAttribute("t") === "s" ? shared[Number(raw)] || "" : raw;
    }
    return result;
  });
  return { rows, sheetName };
}

function safeBrowserUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "/preview/frontier-hypercar.html";
  if (trimmed.startsWith("/")) return trimmed;
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS pages can be opened.");
  return url.href;
}

function SpreadsheetTable({ rows, title }: { rows: string[][]; title: string }) {
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  if (!rows.length) return <div className="preview-empty"><FileSearch size={28} /><strong>{title} is empty</strong></div>;
  return <div className="sheet-preview"><div className="sheet-caption"><strong>{title}</strong><span>{rows.length} rows · {columnCount} columns · capped safe view</span></div><div className="sheet-scroll"><table><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}><th>{rowIndex + 1}</th>{Array.from({ length: columnCount }, (_, columnIndexValue) => <td key={columnIndexValue}>{row[columnIndexValue] || ""}</td>)}</tr>)}</tbody></table></div></div>;
}


function bundleHtmlWithSiblings(html: string, tabs: EditorTab[]): string {
  let bundled = html;
  for (const tab of tabs) {
    if (tab.name.endsWith(".css") && tab.content) {
      const baseName = tab.name.split("/").pop() || tab.name;
      const linkRegex = new RegExp(`<link[^>]*href=["\'](?:\\.\\/)?${baseName}["\'][^>]*>`, "gi");
      if (linkRegex.test(bundled)) {
        bundled = bundled.replace(linkRegex, `<style>/* Injected from ${baseName} */\n${tab.content}\n</style>`);
      } else if (!bundled.includes(tab.content.slice(0, 30))) {
        if (bundled.includes("</head>")) {
          bundled = bundled.replace("</head>", `<style>/* Injected ${baseName} */\n${tab.content}\n</style></head>`);
        } else {
          bundled = `<style>/* Injected ${baseName} */\n${tab.content}\n</style>` + bundled;
        }
      }
    }
  }
  for (const tab of tabs) {
    if ((tab.name.endsWith(".js") || tab.name.endsWith(".mjs")) && tab.content) {
      const baseName = tab.name.split("/").pop() || tab.name;
      const scriptRegex = new RegExp(`<script[^>]*src=["\'](?:\\.\\/)?${baseName}["\'][^>]*>\\s*<\\/script>`, "gi");
      if (scriptRegex.test(bundled)) {
        bundled = bundled.replace(scriptRegex, `<script>/* Injected from ${baseName} */\n${tab.content}\n</script>`);
      }
    }
  }
  return bundled;
}

export const WebsitePreviewPane: React.FC<{ activeTab: EditorTab | null }> = ({ activeTab }) => {
  const liveEdit = useSyncExternalStore(LiveEditService.subscribe, LiveEditService.getSnapshot, LiveEditService.getSnapshot);
  const { referenceScreenshotUrl, setReferenceScreenshotUrl, browserPreviewUrl, setBrowserPreviewUrl, tabs } = useStudioStore();

  useEffect(() => {
    if (browserPreviewUrl) {
      if (/^(?:https?:|\/)/i.test(browserPreviewUrl)) {
        setSurface("browser");
        setBrowserUrl(browserPreviewUrl);
        setAddress(browserPreviewUrl);
      } else {
        setSurface("file");
      }
    }
  }, [browserPreviewUrl]);
  const [surface, setSurface] = useState<PreviewSurface>("file");
  const [refreshKey, setRefreshKey] = useState(0);
  const [address, setAddress] = useState("/preview/frontier-hypercar.html");
  const [browserUrl, setBrowserUrl] = useState("/preview/frontier-hypercar.html");
  const [browserError, setBrowserError] = useState("");
  const [history, setHistory] = useState(["/preview/frontier-hypercar.html"]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [sheet, setSheet] = useState<SheetState>({ status: "idle", rows: [], sheetName: "" });
  const [isComparingReference, setIsComparingReference] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<"overlay" | "side-by-side">("overlay");
  const [comparisonOpacity, setComparisonOpacity] = useState(50);

  const extension = activeTab?.name.split(".").pop()?.toLowerCase() || "";
  const isLiveActive = liveEdit.following && liveEdit.path === activeTab?.path && ["streaming", "committing"].includes(liveEdit.phase);

  const objectUrl = useMemo(() => {
    if (!activeTab || activeTab.encoding !== "base64" || extension !== "pdf") return "";
    const blob = new Blob([base64Bytes(activeTab.content)], { type: activeTab.mimeType || "application/pdf" });
    return URL.createObjectURL(blob);
  }, [activeTab, extension]);
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);

  useEffect(() => {
    let cancelled = false;
    if (!activeTab || !["csv", "xlsx", "xls"].includes(extension)) { setSheet({ status: "idle", rows: [], sheetName: "" }); return; }
    setSheet({ status: "loading", rows: [], sheetName: activeTab.name });
    void (async () => {
      try {
        let result;
        if (extension === "csv") result = { rows: csvRows(activeTab.content), sheetName: activeTab.name };
        else if (extension === "xls" && activeTab.encoding === "utf8") result = { rows: spreadsheetXmlRows(activeTab.content), sheetName: activeTab.name };
        else if (extension === "xlsx") result = await xlsxRows(activeTab.content);
        else throw new Error("Legacy binary .xls preview is not available. Convert it to .xlsx or CSV for a safe in-app preview.");
        if (!cancelled) setSheet({ status: "ready", ...result });
      } catch (error) {
        if (!cancelled) setSheet({ status: "error", rows: [], sheetName: activeTab.name, error: error instanceof Error ? error.message : "Spreadsheet preview failed." });
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, extension]);

  const navigate = () => {
    try {
      const next = safeBrowserUrl(address);
      setBrowserError("");
      setBrowserUrl(next);
      setHistory((current) => [...current.slice(0, historyIndex + 1), next]);
      setHistoryIndex((current) => current + 1);
    } catch (error) { setBrowserError(error instanceof Error ? error.message : "Invalid address."); }
  };

  const moveHistory = (direction: -1 | 1) => {
    const nextIndex = historyIndex + direction;
    if (nextIndex < 0 || nextIndex >= history.length) return;
    setHistoryIndex(nextIndex); setBrowserUrl(history[nextIndex]); setAddress(history[nextIndex]);
  };

  const renderFile = () => {
    if (!activeTab) return <div className="preview-empty"><FileSearch size={30} /><strong>No file selected</strong><p>Choose a file from Explorer to preview its real contents.</p></div>;
    if (["csv", "xlsx", "xls"].includes(extension)) {
      if (sheet.status === "loading") return <div className="preview-empty"><LoaderCircle size={28} className="workspace-spin" /><strong>Reading spreadsheet…</strong></div>;
      if (sheet.status === "error") return <div className="preview-empty preview-error"><FileSearch size={28} /><strong>Spreadsheet preview unavailable</strong><p>{sheet.error}</p></div>;
      return <SpreadsheetTable rows={sheet.rows} title={sheet.sheetName} />;
    }
    if (extension === "pdf" && objectUrl) return <object className="document-preview" data={objectUrl} type="application/pdf"><div className="preview-empty preview-error"><strong>PDF viewer unavailable</strong><a href={objectUrl} target="_blank" rel="noreferrer">Open PDF in a new tab</a></div></object>;
    if (["html", "htm"].includes(extension)) return <iframe key={`${activeTab.id}-${refreshKey}`} className="document-preview" srcDoc={bundleHtmlWithSiblings(activeTab.content, tabs)} title={`${activeTab.name} preview`} sandbox="allow-scripts allow-forms allow-modals allow-popups" />;
    if (extension === "svg") return <iframe key={`${activeTab.id}-${refreshKey}`} className="document-preview" srcDoc={activeTab.content} title={`${activeTab.name} SVG preview`} sandbox="" />;
    if (activeTab.encoding === "utf8") return <pre className="text-file-preview"><code>{activeTab.content}</code></pre>;
    return <div className="preview-empty preview-error"><FileSearch size={28} /><strong>Preview unavailable</strong><p>{activeTab.mimeType || "This binary file type"} is not rendered in the browser.</p></div>;
  };

  return (
    <div className="preview-surface relative">
      <div className="preview-toolbar">
        {isLiveActive && <div className="preview-live-edit" role="status"><span><i />Live Preview</span><button type="button" onClick={LiveEditService.stopFollowing}><Square size={9} fill="currentColor" />Stop Live Edit</button></div>}
        <div className="preview-surface-switch" aria-label="Preview surface">
          <button type="button" className={surface === "file" ? "active" : ""} onClick={() => setSurface("file")}><FileSearch size={14} />File Preview</button>
          <button type="button" className={surface === "browser" ? "active" : ""} onClick={() => setSurface("browser")}><Globe2 size={14} />Browser</button>
        </div>

        {referenceScreenshotUrl && (
          <div className="flex items-center gap-1.5 ml-2">
            <button
              type="button"
              className={`px-2 py-1 rounded text-3xs font-medium flex items-center gap-1 border transition-colors ${
                isComparingReference
                  ? "bg-[#38bdf8]/20 text-[#38bdf8] border-[#38bdf8]/40"
                  : "bg-white/5 text-gray-300 border-white/10 hover:bg-white/10"
              }`}
              onClick={() => setIsComparingReference(!isComparingReference)}
              title="Toggle Reference Screenshot Comparison"
            >
              <Layers size={12} />
              <span>Compare Reference</span>
            </button>
          </div>
        )}

        {surface === "file" ? (
          <div className="preview-file-meta">
            <strong>{activeTab?.name || "No file"}</strong>
            <span>{activeTab ? `${activeTab.mimeType || activeTab.language}${activeTab.size ? ` · ${Math.ceil(activeTab.size / 1024)} KB` : ""}` : "Select a workspace file"}</span>
            <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={!activeTab} title="Reload preview"><RefreshCw size={14} /></button>
          </div>
        ) : (
          <div className="browser-controls">
            <button type="button" onClick={() => moveHistory(-1)} disabled={historyIndex === 0} aria-label="Back"><ArrowLeft size={14} /></button>
            <button type="button" onClick={() => moveHistory(1)} disabled={historyIndex === history.length - 1} aria-label="Forward"><ArrowRight size={14} /></button>
            <button type="button" onClick={() => setRefreshKey((value) => value + 1)} aria-label="Reload"><RefreshCw size={14} /></button>
            <form onSubmit={(event) => { event.preventDefault(); navigate(); }}><Globe2 size={14} /><input value={address} onChange={(event) => setAddress(event.target.value)} aria-label="Browser address" spellCheck={false} /><button type="submit">Go</button></form>
            <a href={browserUrl} target="_blank" rel="noreferrer" title="Open in system browser"><ExternalLink size={14} /></a>
          </div>
        )}
      </div>

      {/* Floating Comparison Controls when comparison is active */}
      {isComparingReference && referenceScreenshotUrl && (
        <div className="absolute top-12 right-4 z-30 bg-[#14171f]/95 border border-[#38bdf8]/40 p-2.5 rounded-xl shadow-2xl backdrop-blur-md flex items-center gap-3 text-xs text-white animate-in fade-in duration-150">
          <div className="flex items-center gap-1 border-r border-white/10 pr-2">
            <button
              type="button"
              onClick={() => setComparisonMode("overlay")}
              className={`px-1.5 py-0.5 rounded text-3xs font-mono transition-colors ${
                comparisonMode === "overlay" ? "bg-[#38bdf8]/25 text-[#38bdf8] font-bold" : "text-gray-400 hover:text-white"
              }`}
            >
              Overlay
            </button>
            <button
              type="button"
              onClick={() => setComparisonMode("side-by-side")}
              className={`px-1.5 py-0.5 rounded text-3xs font-mono transition-colors ${
                comparisonMode === "side-by-side" ? "bg-[#38bdf8]/25 text-[#38bdf8] font-bold" : "text-gray-400 hover:text-white"
              }`}
            >
              Side-by-Side
            </button>
          </div>

          {comparisonMode === "overlay" && (
            <>
              <div className="flex items-center gap-1.5 text-3xs font-medium text-[#38bdf8]">
                <Sliders size={12} />
                <span>Opacity: {comparisonOpacity}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={comparisonOpacity}
                onChange={(e) => setComparisonOpacity(Number(e.target.value))}
                className="w-20 accent-[#38bdf8] cursor-pointer"
              />
            </>
          )}

          <button
            type="button"
            onClick={() => setIsComparingReference(false)}
            className="p-1 text-gray-400 hover:text-white rounded hover:bg-white/10"
            title="Close comparison"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="preview-canvas relative overflow-hidden h-full flex flex-col">
        {isComparingReference && referenceScreenshotUrl && comparisonMode === "side-by-side" ? (
          <div className="grid grid-cols-2 h-full divide-x divide-white/10 bg-[#08090b]">
            {/* Left: Reference Mockup */}
            <div className="flex flex-col h-full overflow-hidden">
              <div className="px-3 py-1.5 bg-[#12141a] border-b border-white/5 text-3xs text-[#38bdf8] font-mono font-bold flex items-center justify-between">
                <span>Reference Screenshot</span>
                <span className="text-gray-500 font-normal">Original Mockup</span>
              </div>
              <div className="flex-1 flex items-center justify-center p-3 overflow-auto">
                <img
                  src={referenceScreenshotUrl}
                  alt="Reference Mockup"
                  className="max-w-full max-h-full object-contain border border-white/10 shadow-lg"
                />
              </div>
            </div>

            {/* Right: Live Render */}
            <div className="flex flex-col h-full overflow-hidden">
              <div className="px-3 py-1.5 bg-[#12141a] border-b border-white/5 text-3xs text-emerald-400 font-mono font-bold flex items-center justify-between">
                <span>Live Render</span>
                <span className="text-gray-500 font-normal">Active Output</span>
              </div>
              <div className="flex-1 relative overflow-hidden">
                {surface === "file" ? renderFile() : <iframe key={`${browserUrl}-${refreshKey}`} className="browser-frame" src={browserUrl} title="Frontier Browser" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" referrerPolicy="strict-origin-when-cross-origin" />}
              </div>
            </div>
          </div>
        ) : (
          <>
            {surface === "file" ? renderFile() : <>{browserError && <div className="browser-error" role="alert">{browserError}</div>}<iframe key={`${browserUrl}-${refreshKey}`} className="browser-frame" src={browserUrl} title="Frontier Browser" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" referrerPolicy="strict-origin-when-cross-origin" /><div className="browser-frame-note">Some external sites block embedding; use the open-in-browser action if a page stays blank.</div></>}

            {/* Reference Screenshot Overlay Layer */}
            {isComparingReference && referenceScreenshotUrl && comparisonMode === "overlay" && (
              <div
                className="absolute inset-0 pointer-events-none z-20 flex items-start justify-center overflow-auto p-2"
                style={{ opacity: comparisonOpacity / 100 }}
              >
                <img
                  src={referenceScreenshotUrl}
                  alt="Reference Mockup"
                  className="max-w-full max-h-full object-contain border border-[#38bdf8]/50 shadow-2xl"
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
