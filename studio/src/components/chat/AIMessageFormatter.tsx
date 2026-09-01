import React, { useState } from "react";
import { Copy, Check, Code2, Play, Sparkles, ChevronDown, ChevronRight, Terminal } from "lucide-react";

interface AIMessageFormatterProps {
  content: string;
  onApplyCode?: (code: string) => void;
}

export const AIMessageFormatter: React.FC<AIMessageFormatterProps> = ({ content, onApplyCode }) => {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [openReasoning, setOpenReasoning] = useState<Record<number, boolean>>({});

  const handleCopy = (code: string, index: number) => {
    navigator.clipboard.writeText(code);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const toggleReasoning = (index: number) => {
    setOpenReasoning((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  // Helper to parse inline markdown (bold, italic, inline code)
  const renderInlineText = (text: string) => {
    const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code
            key={i}
            className="px-1.5 py-0.5 mx-0.5 rounded-md bg-cyan-950/60 text-cyan-300 font-mono text-[11px] border border-cyan-500/20"
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={i} className="font-bold text-white">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith("*") && part.endsWith("*")) {
        return (
          <em key={i} className="italic text-slate-300">
            {part.slice(1, -1)}
          </em>
        );
      }
      return part;
    });
  };

  // Split into code blocks and normal text sections
  const sections = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-3 font-sans text-xs leading-relaxed text-slate-200">
      {sections.map((section, idx) => {
        // Code Block Rendering
        if (section.startsWith("```")) {
          const lines = section.slice(3, -3).trim().split("\n");
          const firstLine = lines[0].trim();
          const hasLang = /^[a-zA-Z0-9_-]+$/.test(firstLine);
          const language = hasLang ? firstLine : "typescript";
          const codeBody = hasLang ? lines.slice(1).join("\n") : lines.join("\n");

          return (
            <div
              key={idx}
              className="my-3 rounded-xl overflow-hidden border border-white/10 bg-[#0a0c10] shadow-xl"
            >
              {/* Code Header */}
              <div className="flex items-center justify-between px-3 py-1.5 bg-[#12161f] border-b border-white/5 font-mono text-[10px]">
                <span className="text-cyan-400 font-semibold uppercase flex items-center gap-1.5">
                  <Code2 size={12} /> {language}
                </span>
                <div className="flex items-center gap-2">
                  {onApplyCode && (
                    <button
                      onClick={() => onApplyCode(codeBody)}
                      className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30 flex items-center gap-1 transition-all"
                      title="Apply code directly to Monaco Editor"
                    >
                      <Play size={10} />
                      <span>Apply to Editor</span>
                    </button>
                  )}
                  <button
                    onClick={() => handleCopy(codeBody, idx)}
                    className="px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-slate-300 flex items-center gap-1 transition-all"
                  >
                    {copiedIndex === idx ? (
                      <>
                        <Check size={10} className="text-emerald-400" />
                        <span className="text-emerald-400">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy size={10} />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Code Body */}
              <pre className="p-3 font-mono text-[11px] text-cyan-200 overflow-x-auto leading-relaxed selection:bg-cyan-500/30">
                <code>{codeBody}</code>
              </pre>
            </div>
          );
        }

        // Paragraphs & Lists Parsing
        const lines = section.split("\n");
        return (
          <div key={idx} className="space-y-2">
            {lines.map((line, lineIdx) => {
              const trimmed = line.trim();
              if (!trimmed) return null;

              // Headers
              if (trimmed.startsWith("### ")) {
                return (
                  <h4 key={lineIdx} className="text-sm font-bold text-white pt-1">
                    {renderInlineText(trimmed.slice(4))}
                  </h4>
                );
              }
              if (trimmed.startsWith("## ")) {
                return (
                  <h3 key={lineIdx} className="text-base font-extrabold text-white pt-1 border-b border-white/10 pb-1">
                    {renderInlineText(trimmed.slice(3))}
                  </h3>
                );
              }
              if (trimmed.startsWith("# ")) {
                return (
                  <h2 key={lineIdx} className="text-lg font-extrabold text-white pt-2">
                    {renderInlineText(trimmed.slice(2))}
                  </h2>
                );
              }

              // Bullet Points
              if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
                return (
                  <div key={lineIdx} className="flex items-start gap-2 pl-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 mt-1.5 flex-shrink-0" />
                    <span className="text-slate-300">{renderInlineText(trimmed.slice(2))}</span>
                  </div>
                );
              }

              // Numbered Steps
              if (/^\d+\.\s/.test(trimmed)) {
                const match = trimmed.match(/^(\d+)\.\s(.*)/);
                if (match) {
                  return (
                    <div key={lineIdx} className="flex items-start gap-2.5 pl-1 py-0.5">
                      <span className="w-4 h-4 rounded-full bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[10px] font-mono font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                        {match[1]}
                      </span>
                      <span className="text-slate-300">{renderInlineText(match[2])}</span>
                    </div>
                  );
                }
              }

              // Standard Paragraph
              return (
                <p key={lineIdx} className="text-slate-200">
                  {renderInlineText(trimmed)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
