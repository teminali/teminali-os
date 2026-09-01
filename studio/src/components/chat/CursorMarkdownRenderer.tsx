import React, { useState } from "react";
import {
  Copy,
  Check,
  Maximize2,
  Minimize2,
  ExternalLink,
  Code2,
  Terminal,
} from "lucide-react";

export const CursorMarkdownRenderer: React.FC<{ content: string }> = ({ content }) => {
  const [copiedCodeIdx, setCopiedCodeIdx] = useState<number | null>(null);
  const [expandedDiagram, setExpandedDiagram] = useState(false);

  const copyCode = (idx: number, code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCodeIdx(idx);
    setTimeout(() => setCopiedCodeIdx(null), 1500);
  };

  // Helper to parse blocks
  const parseBlocks = (raw: string) => {
    const lines = raw.split("\n");
    const blocks: { type: string; content: string; lang?: string; headers?: string[]; rows?: string[][] }[] = [];
    let currentText: string[] = [];
    let inCode = false;
    let codeLang = "";
    let codeLines: string[] = [];
    let inTable = false;
    let tableHeaders: string[] = [];
    let tableRows: string[][] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Code blocks
      if (line.trim().startsWith("```")) {
        if (inCode) {
          blocks.push({ type: "code", content: codeLines.join("\n"), lang: codeLang });
          codeLines = [];
          inCode = false;
          codeLang = "";
        } else {
          if (currentText.length > 0) {
            blocks.push({ type: "text", content: currentText.join("\n") });
            currentText = [];
          }
          inCode = true;
          codeLang = line.trim().slice(3).trim();
        }
        continue;
      }

      if (inCode) {
        codeLines.push(line);
        continue;
      }

      // Markdown Tables
      if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
        const cells = line
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());

        if (cells.every((c) => c.match(/^:?-+:?$/))) {
          // Separator row, skip
          continue;
        }

        if (!inTable) {
          if (currentText.length > 0) {
            blocks.push({ type: "text", content: currentText.join("\n") });
            currentText = [];
          }
          inTable = true;
          tableHeaders = cells;
          tableRows = [];
        } else {
          tableRows.push(cells);
        }
        continue;
      } else if (inTable) {
        blocks.push({ type: "table", content: "", headers: tableHeaders, rows: tableRows });
        inTable = false;
        tableHeaders = [];
        tableRows = [];
      }

      currentText.push(line);
    }

    if (inCode) {
      blocks.push({ type: "code", content: codeLines.join("\n"), lang: codeLang });
    }
    if (inTable) {
      blocks.push({ type: "table", content: "", headers: tableHeaders, rows: tableRows });
    }
    if (currentText.length > 0) {
      blocks.push({ type: "text", content: currentText.join("\n") });
    }

    return blocks;
  };

  const renderInline = (text: string) => {
    // Process bold, inline code, links
    const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return parts.map((part, idx) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        const codeText = part.slice(1, -1);
        return (
          <code
            key={idx}
            className="px-1.5 py-0.5 rounded bg-white/5 text-[#38bdf8] font-mono text-xs border border-white/5"
          >
            {codeText}
          </code>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        const boldText = part.slice(2, -2);
        return (
          <strong key={idx} className="font-semibold text-white">
            {boldText}
          </strong>
        );
      }
      return <span key={idx}>{part}</span>;
    });
  };

  const blocks = parseBlocks(content);

  return (
    <div className="space-y-4 font-sans text-sm text-gray-200 leading-relaxed">
      {blocks.map((block, idx) => {
        if (block.type === "code") {
          const isDiagram = block.lang === "diagram" || block.lang === "architecture" || block.content.includes("├──") || block.content.includes("┌──");

          if (isDiagram) {
            return (
              <div
                key={idx}
                className="my-4 bg-[#1b1b1b] border border-white/5 rounded-2xl p-5 shadow-xl relative group font-mono text-xs"
              >
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/5 text-gray-400 text-2xs">
                  <span className="font-medium tracking-wide text-gray-300">Architecture Diagram</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setExpandedDiagram((p) => !p)}
                      className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors"
                      title="Expand diagram"
                    >
                      <Maximize2 size={13} />
                    </button>
                  </div>
                </div>
                <pre className="text-gray-300 overflow-x-auto whitespace-pre leading-relaxed">
                  {block.content}
                </pre>
              </div>
            );
          }

          return (
            <div
              key={idx}
              className="my-3 bg-[#191919] border border-white/5 rounded-xl overflow-hidden group shadow-lg font-mono text-xs"
            >
              <div className="flex items-center justify-between px-3.5 py-2 bg-[#1f1f1f] border-b border-white/5 text-2xs text-gray-400">
                <span className="font-semibold">{block.lang || "bash"}</span>
                <button
                  onClick={() => copyCode(idx, block.content)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white/5 hover:text-white transition-colors"
                >
                  {copiedCodeIdx === idx ? (
                    <>
                      <Check size={12} className="text-[#22c55e]" />
                      <span className="text-[#22c55e]">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <div className="p-4 overflow-x-auto text-gray-300 leading-relaxed">
                {block.content.split("\n").map((line, lIdx) => {
                  if (line.trim().startsWith("#")) {
                    return (
                      <div key={lIdx} className="text-gray-500 italic">
                        {line}
                      </div>
                    );
                  }
                  if (line.includes("#")) {
                    const [cmd, comment] = line.split("#");
                    return (
                      <div key={lIdx}>
                        <span className="text-[#f43f5e]">{cmd}</span>
                        <span className="text-gray-500 italic">#{comment}</span>
                      </div>
                    );
                  }
                  return <div key={lIdx}>{line}</div>;
                })}
              </div>
            </div>
          );
        }

        if (block.type === "table") {
          return (
            <div key={idx} className="my-4 border border-white/5 rounded-xl overflow-hidden shadow-lg bg-[#191919]">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[#1e1e1e] border-b border-white/5 text-gray-400 font-semibold text-2xs uppercase tracking-wider">
                    {block.headers?.map((h, hIdx) => (
                      <th key={hIdx} className="px-4 py-2.5">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {block.rows?.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-white/[0.02] transition-colors">
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="px-4 py-2.5 text-gray-300">
                          {renderInline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        // Standard Text Block
        return (
          <div key={idx} className="space-y-2">
            {block.content.split("\n").map((paragraph, pIdx) => {
              const trimmed = paragraph.trim();
              if (!trimmed) return null;

              if (trimmed.startsWith("### ")) {
                return (
                  <h3 key={pIdx} className="text-sm font-semibold text-white mt-4 mb-1">
                    {renderInline(trimmed.slice(4))}
                  </h3>
                );
              }
              if (trimmed.startsWith("## ")) {
                return (
                  <h2 key={pIdx} className="text-base font-semibold text-white tracking-tight mt-5 mb-2">
                    {renderInline(trimmed.slice(3))}
                  </h2>
                );
              }
              if (trimmed.startsWith("# ")) {
                return (
                  <h1 key={pIdx} className="text-lg font-bold text-white tracking-tight mt-6 mb-2">
                    {renderInline(trimmed.slice(2))}
                  </h1>
                );
              }
              if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
                return (
                  <li key={pIdx} className="ml-4 list-disc list-outside text-gray-300 leading-relaxed my-0.5">
                    {renderInline(trimmed.slice(2))}
                  </li>
                );
              }
              if (trimmed.match(/^\d+\.\s/)) {
                const match = trimmed.match(/^\d+\.\s/);
                const num = match ? match[0] : "1. ";
                return (
                  <div key={pIdx} className="flex gap-2 text-gray-300 leading-relaxed my-1">
                    <span className="font-semibold text-gray-400">{num}</span>
                    <span>{renderInline(trimmed.slice(num.length))}</span>
                  </div>
                );
              }

              return (
                <p key={pIdx} className="leading-relaxed text-gray-300">
                  {renderInline(paragraph)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
