import React, { useState } from "react";
import { ArrowUpRight, Check, ChevronRight, Code2, Copy, FileText, SquareTerminal } from "lucide-react";
import { highlightCode } from "../../utils/syntaxHighlight";

/**
 * A block of code inside a reply: one 28px line that opens onto the code.
 *
 * Collapsed by default on purpose. A reply that touches five files should read
 * as five lines you can scan, not five screens you have to scroll past — the
 * code is one click away when you actually want it.
 *
 * The row carries the chevron, the name, the size and the two or three things
 * you can do with it, and nothing else. It previously ended in an "Expand"
 * chip that did exactly what the chevron beside it did, and a "Copy" that
 * spelled out its own label — a header wider than most of the filenames in it.
 */

export interface FileActionCardProps {
  /** File name, or the command for a runnable block. */
  title: string;
  code: string;
  language?: string;
  /** Renders as a command card with a run action instead of a file card. */
  runnable?: boolean;
  onJumpToFile?: () => void;
  onRun?: () => void;
  defaultOpen?: boolean;
}

export const FileActionCard: React.FC<FileActionCardProps> = ({
  title,
  code,
  language = "typescript",
  runnable = false,
  onJumpToFile,
  onRun,
  defaultOpen = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n").length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard blocked — the code is still selectable in the reveal. */
    }
  };

  return (
    <div className="rounded-lg border border-edge/70 bg-surface-sunken overflow-hidden">
      <div className="group h-8 flex items-center gap-2 px-2 hover:bg-surface-hover/50 transition-colors duration-ds ease-ds">
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          className="flex-1 min-w-0 h-full flex items-center gap-2 text-left"
        >
          <ChevronRight
            size={12}
            className={`flex-shrink-0 text-ink-disabled transition-transform duration-ds ease-ds ${open ? "rotate-90" : ""}`}
          />
          {runnable ? (
            <SquareTerminal size={12} className="text-ink-faint flex-shrink-0" />
          ) : /\.(tsx?|jsx?|mjs|cjs)$/.test(title) ? (
            <Code2 size={12} className="text-ink-faint flex-shrink-0" />
          ) : (
            <FileText size={12} className="text-ink-faint flex-shrink-0" />
          )}
          <span className="font-mono text-2xs text-ink-dim truncate">{title}</span>
          <span className="font-mono text-3xs text-ink-disabled tabular-nums flex-shrink-0">{lines}L</span>
        </button>

        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-ds ease-ds">
          {onJumpToFile && (
            <IconAction onClick={onJumpToFile} title="Open in the editor">
              <ArrowUpRight size={12} />
            </IconAction>
          )}
          {runnable && onRun && (
            <IconAction onClick={onRun} title="Run in the terminal">
              <SquareTerminal size={12} />
            </IconAction>
          )}
          <IconAction onClick={copy} title="Copy">
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          </IconAction>
        </span>
      </div>

      {open && (
        <pre
          className="border-t border-edge/60 px-3 py-2.5 overflow-x-auto font-mono text-2xs leading-[1.75] text-ink-code animate-reveal"
          dangerouslySetInnerHTML={{ __html: highlightCode(code, language) }}
        />
      )}
    </div>
  );
};

const IconAction: React.FC<{ onClick: () => void; title: string; children: React.ReactNode }> = ({
  onClick,
  title,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className="w-6 h-6 flex items-center justify-center rounded text-ink-faint hover:text-ink-high hover:bg-surface-hover transition-colors duration-ds ease-ds"
  >
    {children}
  </button>
);
