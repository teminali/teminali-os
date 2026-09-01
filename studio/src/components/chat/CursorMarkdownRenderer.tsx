import React, { useState } from "react";
import {
  Maximize2,
  Minimize2,
} from "lucide-react";
import { CodeSnippet } from "../ui/CodeSnippet";

export interface CursorMarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

export const CursorMarkdownRenderer: React.FC<CursorMarkdownRendererProps> = ({
  content,
  isStreaming = false,
}) => {
  const [expandedDiagram, setExpandedDiagram] = useState(false);

  // Helper to parse markdown blocks
  const parseBlocks = (raw: string) => {
    const lines = raw.split("\n");
    const blocks: {
      type: "code" | "table" | "text";
      content: string;
      lang?: string;
      headers?: string[];
      rows?: string[][];
    }[] = [];

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

      // Tables
      if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
        if (!inTable) {
          if (currentText.length > 0) {
            blocks.push({ type: "text", content: currentText.join("\n") });
            currentText = [];
          }
          inTable = true;
          tableHeaders = line
            .split("|")
            .slice(1, -1)
            .map((h) => h.trim());
          continue;
        } else {
          // Table separator row
          if (line.includes("---")) continue;

          const rowCells = line
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim());
          tableRows.push(rowCells);
          continue;
        }
      }

      if (inTable && (!line.trim().startsWith("|") || !line.trim().endsWith("|"))) {
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
            className="px-1.5 py-0.5 rounded bg-white/5 text-[#FF6C37] font-mono text-xs border border-white/5"
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
    <div className="space-y-3 font-sans text-sm text-gray-200 leading-relaxed">
      {blocks.map((block, idx) => {
        if (block.type === "code") {
          const isDiagram =
            block.lang === "diagram" ||
            block.lang === "architecture" ||
            block.content.includes("├──") ||
            block.content.includes("┌──");

          if (isDiagram) {
            return (
              <div
                key={idx}
                className="my-3 bg-[#0f0f13] border border-white/10 rounded-xl p-4 shadow-xl relative group font-mono text-xs"
              >
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/5 text-gray-400 text-2xs">
                  <span className="font-medium tracking-wide text-gray-300">
                    Architecture Diagram
                  </span>
                  <button
                    onClick={() => setExpandedDiagram((p) => !p)}
                    className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors"
                    title="Expand diagram"
                  >
                    {expandedDiagram ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  </button>
                </div>
                <pre className="text-gray-300 overflow-x-auto whitespace-pre leading-relaxed">
                  {block.content}
                </pre>
              </div>
            );
          }

          // Modular, Minimizable Code Snippet
          return (
            <CodeSnippet
              key={idx}
              content={block.content}
              lang={block.lang}
              isStreaming={isStreaming}
            />
          );
        }

        if (block.type === "table") {
          return (
            <div
              key={idx}
              className="my-3 border border-white/10 rounded-xl overflow-hidden shadow-lg bg-[#0f0f13]"
            >
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[#16161a] border-b border-white/10 text-gray-400 font-semibold text-2xs uppercase tracking-wider">
                    {block.headers?.map((h, hIdx) => (
                      <th key={hIdx} className="px-3.5 py-2">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {block.rows?.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-white/[0.02] transition-colors">
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="px-3.5 py-2 text-gray-300">
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
          <div key={idx} className="space-y-1.5">
            {block.content.split("\n").map((paragraph, pIdx) => {
              const trimmed = paragraph.trim();
              if (!trimmed) return null;

              if (trimmed.startsWith("### ")) {
                return (
                  <h3 key={pIdx} className="text-xs font-semibold text-white mt-3 mb-1">
                    {renderInline(trimmed.slice(4))}
                  </h3>
                );
              }
              if (trimmed.startsWith("## ")) {
                return (
                  <h2
                    key={pIdx}
                    className="text-sm font-semibold text-white tracking-tight mt-4 mb-1.5"
                  >
                    {renderInline(trimmed.slice(3))}
                  </h2>
                );
              }
              if (trimmed.startsWith("# ")) {
                return (
                  <h1
                    key={pIdx}
                    className="text-base font-bold text-white tracking-tight mt-5 mb-2"
                  >
                    {renderInline(trimmed.slice(2))}
                  </h1>
                );
              }
              if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
                return (
                  <li
                    key={pIdx}
                    className="ml-4 list-disc list-outside text-gray-300 leading-relaxed my-0.5"
                  >
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
                <p key={pIdx} className="leading-relaxed text-gray-300 text-xs">
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
