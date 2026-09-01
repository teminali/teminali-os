import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FileSearch,
  Globe2,
  LoaderCircle,
  RefreshCw,
  Square,
  Layers,
  Sliders,
  X,
  Monitor,
  Tablet,
  Smartphone,
  Copy,
  Check,
  Lock,
  Sparkles,
  Code2,
  FileCode,
  Eye,
} from "lucide-react";
import type { EditorTab } from "../../types";
import { LiveEditService } from "../../services/liveEditService";
import { useStudioStore } from "../../store/studioStore";

type PreviewSurface = "file" | "browser";
type ViewportMode = "desktop" | "tablet" | "mobile";
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

function bundleHtmlWithSiblings(html: string, tabs: EditorTab[]): string {
  let bundled = html;
  // Inject sibling CSS stylesheets
  for (const tab of tabs) {
    if (tab.name.endsWith(".css") && tab.content) {
      const baseName = tab.name.split("/").pop() || tab.name;
      const linkRegex = new RegExp(`<link[^>]*href=["'](?:\\.\\/)?${baseName}["'][^>]*>`, "gi");
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
  // Inject sibling JavaScript scripts
  for (const tab of tabs) {
    if ((tab.name.endsWith(".js") || tab.name.endsWith(".mjs")) && tab.content) {
      const baseName = tab.name.split("/").pop() || tab.name;
      const scriptRegex = new RegExp(`<script[^>]*src=["'](?:\\.\\/)?${baseName}["'][^>]*>\\s*<\\/script>`, "gi");
      if (scriptRegex.test(bundled)) {
        bundled = bundled.replace(scriptRegex, `<script>/* Injected from ${baseName} */\n${tab.content}\n</script>`);
      }
    }
  }
  return bundled;
}

function SpreadsheetTable({ rows, title }: { rows: string[][]; title: string }) {
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  if (!rows.length) return <div className="preview-empty"><FileSearch size={28} /><strong>{title} is empty</strong></div>;
  return (
    <div className="sheet-preview">
      <div className="sheet-caption">
        <strong>{title}</strong>
        <span>{rows.length} rows · {columnCount} columns · safe spreadsheet view</span>
      </div>
      <div className="sheet-scroll">
        <table>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th>{rowIndex + 1}</th>
                {Array.from({ length: columnCount }, (_, columnIndexValue) => (
                  <td key={columnIndexValue}>{row[columnIndexValue] || ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const WebsitePreviewPane: React.FC<{ activeTab: EditorTab | null }> = ({ activeTab }) => {
  const liveEdit = useSyncExternalStore(LiveEditService.subscribe, LiveEditService.getSnapshot, LiveEditService.getSnapshot);
  const {
    referenceScreenshotUrl,
    setReferenceScreenshotUrl,
    browserPreviewUrl,
    setBrowserPreviewUrl,
    tabs,
    openFile,
    activeTabId,
    setActiveTab,
  } = useStudioStore();

  const [surface, setSurface] = useState<PreviewSurface>("browser");
  const [viewport, setViewport] = useState<ViewportMode>("desktop");
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
  const [copiedCode, setCopiedCode] = useState(false);

  const extension = activeTab?.name.split(".").pop()?.toLowerCase() || "";
  const isLiveActive = liveEdit.following && liveEdit.path === activeTab?.path && ["streaming", "committing"].includes(liveEdit.phase);

  // Sync with global browser preview URL
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

  // If activeTab is an HTML file, default to file preview or browser
  useEffect(() => {
    if (activeTab && (activeTab.name.endsWith(".html") || activeTab.name.endsWith(".htm"))) {
      // Keep surface in sync with active HTML document
    }
  }, [activeTab]);

  const objectUrl = useMemo(() => {
    if (!activeTab || activeTab.encoding !== "base64" || extension !== "pdf") return "";
    const blob = new Blob([base64Bytes(activeTab.content)], { type: activeTab.mimeType || "application/pdf" });
    return URL.createObjectURL(blob);
  }, [activeTab, extension]);
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);

  // Spreadsheet parser effect
  useEffect(() => {
    let cancelled = false;
    if (!activeTab || !["csv", "xlsx", "xls"].includes(extension)) {
      setSheet({ status: "idle", rows: [], sheetName: "" });
      return;
    }
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
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : "Invalid address.");
    }
  };

  const moveHistory = (direction: -1 | 1) => {
    const nextIndex = historyIndex + direction;
    if (nextIndex < 0 || nextIndex >= history.length) return;
    setHistoryIndex(nextIndex);
    setBrowserUrl(history[nextIndex]);
    setAddress(history[nextIndex]);
  };

  // Find all HTML files in open tabs
  const htmlTabs = tabs.filter((t) => t.name.endsWith(".html") || t.name.endsWith(".htm"));

  const renderFile = () => {
    if (!activeTab) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[#09090c] text-gray-400 select-none">
          <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mb-4 text-[#FF6C37] shadow-inner">
            <Globe2 size={24} />
          </div>
          <h3 className="text-sm font-semibold text-white mb-1">No Active Preview File</h3>
          <p className="text-xs text-gray-400 max-w-sm mb-6 leading-relaxed">
            Select an HTML document or web component from your tabs below to render live in the built-in browser.
          </p>
          {htmlTabs.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-2 max-w-md">
              {htmlTabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className="px-3 py-1.5 rounded-lg text-xs font-mono bg-[#16161a] border border-white/10 hover:border-[#FF6C37]/40 hover:text-white text-gray-300 transition-all flex items-center gap-1.5 shadow-sm"
                >
                  <FileCode size={13} className="text-[#FF6C37]" />
                  <span>{t.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (["csv", "xlsx", "xls"].includes(extension)) {
      if (sheet.status === "loading") {
        return (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-gray-400">
            <LoaderCircle size={28} className="animate-spin text-[#FF6C37] mb-2" />
            <strong className="text-sm text-white">Reading spreadsheet…</strong>
          </div>
        );
      }
      if (sheet.status === "error") {
        return (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-rose-400">
            <FileSearch size={28} className="mb-2" />
            <strong className="text-sm">Spreadsheet preview unavailable</strong>
            <p className="text-xs text-gray-400 mt-1">{sheet.error}</p>
          </div>
        );
      }
      return <SpreadsheetTable rows={sheet.rows} title={sheet.sheetName} />;
    }

    if (extension === "pdf" && objectUrl) {
      return (
        <object className="w-full h-full border-0" data={objectUrl} type="application/pdf">
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-gray-400">
            <strong className="text-sm text-white">PDF viewer unavailable</strong>
            <a href={objectUrl} target="_blank" rel="noreferrer" className="text-xs text-[#FF6C37] underline mt-1">
              Open PDF in a new tab
            </a>
          </div>
        </object>
      );
    }

    if (["html", "htm"].includes(extension)) {
      const bundledHtml = bundleHtmlWithSiblings(activeTab.content, tabs);
      return (
        <iframe
          key={`${activeTab.id}-${refreshKey}`}
          className="w-full h-full border-0 bg-transparent block"
          srcDoc={bundledHtml}
          title={`${activeTab.name} preview`}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
        />
      );
    }

    if (extension === "svg") {
      return (
        <iframe
          key={`${activeTab.id}-${refreshKey}`}
          className="w-full h-full border-0 bg-transparent block"
          srcDoc={activeTab.content}
          title={`${activeTab.name} SVG preview`}
          sandbox=""
        />
      );
    }

    // Formatted Code View for non-HTML text files
    if (activeTab.encoding === "utf8") {
      const lines = activeTab.content.split("\n");
      return (
        <div className="flex-1 flex flex-col h-full bg-[#0c0d12] overflow-hidden text-xs font-mono">
          <div className="px-3 py-1.5 bg-[#12141a] border-b border-white/5 flex items-center justify-between text-gray-400 select-none">
            <span className="text-3xs text-gray-400">{lines.length} lines · UTF-8 · {activeTab.language}</span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(activeTab.content);
                setCopiedCode(true);
                setTimeout(() => setCopiedCode(false), 1500);
              }}
              className="flex items-center gap-1 text-3xs text-gray-400 hover:text-white px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
            >
              {copiedCode ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
              <span>{copiedCode ? "Copied" : "Copy Content"}</span>
            </button>
          </div>
          <div className="flex-1 overflow-auto p-4 flex gap-4 text-gray-300 select-text">
            <div className="select-none text-gray-600 text-right pr-2 font-mono" style={{ minWidth: "2.5rem" }}>
              {lines.map((_, i) => (
                <div key={i} className="leading-5">{i + 1}</div>
              ))}
            </div>
            <pre className="flex-1 font-mono leading-5 text-gray-200 overflow-x-auto">
              <code>{activeTab.content}</code>
            </pre>
          </div>
        </div>
      );
    }

    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-gray-400">
        <FileSearch size={28} className="mb-2 text-gray-500" />
        <strong className="text-sm text-white">Preview unavailable</strong>
        <p className="text-xs text-gray-500 mt-1">{activeTab.mimeType || "This binary file type"} cannot be rendered.</p>
      </div>
    );
  };

  // Viewport dimensions
  const getViewportContainerStyle = () => {
    if (viewport === "tablet") return "w-[768px] h-full max-h-[92%] my-auto shadow-2xl rounded-xl ring-1 ring-white/10 overflow-hidden bg-[#09090c]";
    if (viewport === "mobile") return "w-[375px] h-full max-h-[88%] my-auto shadow-2xl rounded-2xl ring-1 ring-white/10 overflow-hidden bg-[#09090c]";
    return "w-full h-full overflow-hidden";
  };

  return (
    <div className="w-full h-full flex flex-col overflow-hidden bg-[#09090c] text-gray-200 select-none">
      {/* ── Top Header Toolbar ────────────────────────────────────────────── */}
      <header className="h-11 px-3 flex items-center justify-between border-b border-white/5 bg-[#0f0f13] flex-shrink-0 gap-2">
        {/* Left: Surface Switcher & Live indicator */}
        <div className="flex items-center gap-2">
          {isLiveActive && (
            <div className="h-6 px-2 rounded-full flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-3xs font-mono animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span>Live Edit</span>
              <button
                type="button"
                onClick={LiveEditService.stopFollowing}
                className="ml-1 text-rose-400 hover:text-rose-300 p-0.5 rounded hover:bg-rose-500/20"
                title="Stop Live Edit"
              >
                <Square size={8} fill="currentColor" />
              </button>
            </div>
          )}

          {/* Mode Pill Toggle: File Preview vs Live Browser */}
          <div className="flex items-center p-0.5 bg-[#16161a] border border-white/10 rounded-lg shadow-inner">
            <button
              type="button"
              onClick={() => setSurface("browser")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                surface === "browser"
                  ? "bg-[#FF6C37]/15 text-[#FF6C37] border border-[#FF6C37]/30 shadow-sm font-semibold"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              <Globe2 size={13} className={surface === "browser" ? "text-[#FF6C37]" : ""} />
              <span>Live Browser</span>
            </button>

            <button
              type="button"
              onClick={() => setSurface("file")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                surface === "file"
                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm font-semibold"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              <FileCode size={13} className={surface === "file" ? "text-emerald-400" : ""} />
              <span>File Preview</span>
            </button>
          </div>

          {/* Reference Screenshot comparison button */}
          {referenceScreenshotUrl && (
            <button
              type="button"
              onClick={() => setIsComparingReference(!isComparingReference)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-3xs font-medium border transition-colors ${
                isComparingReference
                  ? "bg-[#FF6C37]/20 text-[#FF6C37] border-[#FF6C37]/40 shadow-sm"
                  : "bg-white/5 text-gray-400 border-white/10 hover:text-white hover:bg-white/10"
              }`}
              title="Toggle Reference Screenshot Mockup Comparison"
            >
              <Layers size={11} />
              <span>Compare Mockup</span>
            </button>
          )}
        </div>

        {/* Center: Omnibar or File Details */}
        {surface === "browser" ? (
          <div className="flex-1 max-w-md flex items-center gap-1">
            <button
              type="button"
              onClick={() => moveHistory(-1)}
              disabled={historyIndex === 0}
              className="p-1 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white/5"
              title="Back"
            >
              <ArrowLeft size={13} />
            </button>
            <button
              type="button"
              onClick={() => moveHistory(1)}
              disabled={historyIndex === history.length - 1}
              className="p-1 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white/5"
              title="Forward"
            >
              <ArrowRight size={13} />
            </button>
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 transition-transform active:rotate-180"
              title="Reload frame"
            >
              <RefreshCw size={13} />
            </button>

            {/* Address bar input form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                navigate();
              }}
              className="flex-1 flex items-center gap-1.5 h-7 px-2.5 bg-[#0a0a0d] border border-white/10 focus-within:border-[#FF6C37]/50 rounded-lg text-xs font-mono transition-colors shadow-inner"
            >
              <Lock size={11} className="text-emerald-400 flex-shrink-0 opacity-70" />
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="flex-1 bg-transparent border-0 outline-none text-gray-200 text-xs placeholder:text-gray-600 truncate"
                placeholder="http://localhost:3000/..."
                spellCheck={false}
              />
              <button
                type="submit"
                className="text-3xs uppercase font-bold text-[#FF6C37] hover:text-sky-300 px-1 py-0.5 rounded hover:bg-white/5"
              >
                Go
              </button>
            </form>

            <a
              href={browserUrl}
              target="_blank"
              rel="noreferrer"
              className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 ml-0.5"
              title="Open in external browser window"
            >
              <ExternalLink size={13} />
            </a>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-gray-300 font-semibold truncate max-w-[200px]">
              {activeTab?.name || "No document"}
            </span>
            {activeTab && (
              <span className="text-3xs font-mono text-gray-500 uppercase bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
                {extension} · {activeTab.content ? `${Math.ceil(activeTab.content.length / 1024)} KB` : "0 KB"}
              </span>
            )}
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={!activeTab}
              className="p-1 rounded text-gray-400 hover:text-white disabled:opacity-30 hover:bg-white/5"
              title="Reload preview"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        )}

        {/* Right: Viewport Device Switcher */}
        <div className="flex items-center p-0.5 bg-[#16161a] border border-white/10 rounded-lg">
          <button
            type="button"
            onClick={() => setViewport("desktop")}
            className={`p-1.5 rounded-md transition-colors ${
              viewport === "desktop" ? "bg-[#FF6C37]/20 text-[#FF6C37]" : "text-gray-400 hover:text-white"
            }`}
            title="Desktop Viewport (100%)"
          >
            <Monitor size={13} />
          </button>
          <button
            type="button"
            onClick={() => setViewport("tablet")}
            className={`p-1.5 rounded-md transition-colors ${
              viewport === "tablet" ? "bg-[#FF6C37]/20 text-[#FF6C37]" : "text-gray-400 hover:text-white"
            }`}
            title="Tablet Viewport (768px)"
          >
            <Tablet size={13} />
          </button>
          <button
            type="button"
            onClick={() => setViewport("mobile")}
            className={`p-1.5 rounded-md transition-colors ${
              viewport === "mobile" ? "bg-[#FF6C37]/20 text-[#FF6C37]" : "text-gray-400 hover:text-white"
            }`}
            title="Mobile Viewport (375px)"
          >
            <Smartphone size={13} />
          </button>
        </div>
      </header>

      {/* Floating Reference Screenshot Comparison Tool */}
      {isComparingReference && referenceScreenshotUrl && (
        <div className="absolute top-14 right-4 z-30 bg-[#14171f]/95 border border-[#FF6C37]/40 p-2.5 rounded-xl shadow-2xl backdrop-blur-md flex items-center gap-3 text-xs text-white">
          <div className="flex items-center gap-1 border-r border-white/10 pr-2">
            <button
              type="button"
              onClick={() => setComparisonMode("overlay")}
              className={`px-1.5 py-0.5 rounded text-3xs font-mono transition-colors ${
                comparisonMode === "overlay" ? "bg-[#FF6C37]/25 text-[#FF6C37] font-bold" : "text-gray-400 hover:text-white"
              }`}
            >
              Overlay
            </button>
            <button
              type="button"
              onClick={() => setComparisonMode("side-by-side")}
              className={`px-1.5 py-0.5 rounded text-3xs font-mono transition-colors ${
                comparisonMode === "side-by-side" ? "bg-[#FF6C37]/25 text-[#FF6C37] font-bold" : "text-gray-400 hover:text-white"
              }`}
            >
              Side-by-Side
            </button>
          </div>

          {comparisonMode === "overlay" && (
            <>
              <div className="flex items-center gap-1.5 text-3xs font-medium text-[#FF6C37]">
                <Sliders size={12} />
                <span>Opacity: {comparisonOpacity}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={comparisonOpacity}
                onChange={(e) => setComparisonOpacity(Number(e.target.value))}
                className="w-20 accent-[#FF6C37] cursor-pointer"
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

      {/* ── Main Preview Canvas & Responsive Viewport ────────────────────── */}
      <div className="flex-1 relative overflow-hidden flex items-center justify-center p-0 bg-[#06070a]">
        <div className={getViewportContainerStyle()}>
          {isComparingReference && referenceScreenshotUrl && comparisonMode === "side-by-side" ? (
            <div className="grid grid-cols-2 h-full divide-x divide-white/10 bg-[#08090b]">
              {/* Left: Original Mockup */}
              <div className="flex flex-col h-full overflow-hidden">
                <div className="px-3 py-1.5 bg-[#12141a] border-b border-white/5 text-3xs text-[#FF6C37] font-mono font-bold flex items-center justify-between">
                  <span>Reference Screenshot</span>
                  <span className="text-gray-500 font-normal">Original Mockup</span>
                </div>
                <div className="flex-1 flex items-center justify-center p-3 overflow-auto">
                  <img
                    src={referenceScreenshotUrl}
                    alt="Reference Mockup"
                    className="max-w-full max-h-full object-contain border border-white/10 shadow-lg rounded"
                  />
                </div>
              </div>

              {/* Right: Live Render Output */}
              <div className="flex flex-col h-full overflow-hidden">
                <div className="px-3 py-1.5 bg-[#12141a] border-b border-white/5 text-3xs text-emerald-400 font-mono font-bold flex items-center justify-between">
                  <span>Live Render</span>
                  <span className="text-gray-500 font-normal">Active Output</span>
                </div>
                <div className="flex-1 relative overflow-hidden bg-[#09090c]">
                  {surface === "file" ? (
                    renderFile()
                  ) : (
                    <iframe
                      key={`${browserUrl}-${refreshKey}`}
                      className="w-full h-full border-0 bg-transparent block"
                      src={browserUrl}
                      title="Teminali Browser Preview"
                      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
                      referrerPolicy="strict-origin-when-cross-origin"
                    />
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="relative w-full h-full flex flex-col bg-[#09090c] overflow-hidden">
              {surface === "file" ? (
                renderFile()
              ) : (
                <>
                  {browserError && (
                    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-lg bg-rose-950/90 border border-rose-500/40 text-rose-200 text-xs shadow-xl backdrop-blur-sm flex items-center gap-2">
                      <span>{browserError}</span>
                      <button onClick={() => setBrowserError("")} className="hover:text-white"><X size={12} /></button>
                    </div>
                  )}
                  <iframe
                    key={`${browserUrl}-${refreshKey}`}
                    className="w-full h-full border-0 bg-transparent block"
                    src={browserUrl}
                    title="Teminali Browser Preview"
                    sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                </>
              )}

              {/* Overlay Comparison Mode */}
              {isComparingReference && referenceScreenshotUrl && comparisonMode === "overlay" && (
                <div
                  className="absolute inset-0 pointer-events-none z-20 flex items-start justify-center overflow-auto p-2"
                  style={{ opacity: comparisonOpacity / 100 }}
                >
                  <img
                    src={referenceScreenshotUrl}
                    alt="Reference Mockup"
                    className="max-w-full max-h-full object-contain border border-[#FF6C37]/50 shadow-2xl rounded"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
