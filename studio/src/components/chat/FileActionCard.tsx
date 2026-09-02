import React, { useState } from "react";
import { ChevronRight, Copy, Check, FileText, Code2, SquareTerminal, ArrowUpRight } from "lucide-react";
import { highlightCode } from "../../utils/syntaxHighlight";
import { Chip } from "../ui";

/**
 * The file/code card from the design: a one-line header that expands to reveal
 * the code beneath it.
 *
 * Collapsed by default on purpose. A reply that touches five files should read
 * as five lines you can scan, not five screens you have to scroll past — the
 * code is one click away when you actually want it.
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
    <div className="flex flex-col gap-2">
      <div className="lit lit-inner h-9 rounded-md bg-surface flex items-center px-3 gap-3">
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          aria-label={open ? "Collapse" : "Expand"}
          className="flex-shrink-0 text-accent-dim hover:text-accent transition-colors duration-ds ease-ds"
        >
          <ChevronRight
            size={13}
            className={`transition-transform duration-ds ease-ds ${open ? "rotate-90" : ""}`}
          />
        </button>

        {runnable ? (
          <SquareTerminal size={13} className="text-ink-muted flex-shrink-0" />
        ) : /\.(tsx?|jsx?)$/.test(title) ? (
          <Code2 size={13} className="text-accent-dim flex-shrink-0" />
        ) : (
          <FileText size={13} className="text-accent-dim flex-shrink-0" />
        )}

        <span className="font-mono text-xs font-semibold text-ink-high truncate">{title}</span>
        <Chip>{lines} {lines === 1 ? "line" : "lines"}</Chip>

        <div className="flex-1" />

        {onJumpToFile && (
          <Chip as="button" onClick={onJumpToFile}>
            <ArrowUpRight size={11} />
            Jump to File
          </Chip>
        )}
        {runnable && onRun && (
          <Chip as="button" onClick={onRun}>
            <SquareTerminal size={11} />
            Run in Terminal
          </Chip>
        )}
        <button
          type="button"
          onClick={copy}
          title="Copy"
          className="flex items-center gap-1.5 font-mono text-2xs text-ink-dim hover:text-ink-high px-1.5 py-1 transition-colors duration-ds ease-ds flex-shrink-0"
        >
          {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
        <Chip as="button" onClick={() => setOpen((previous) => !previous)}>
          {open ? "Collapse" : "Expand"}
        </Chip>
      </div>

      {open && (
        <pre
          className="lit rounded-lg bg-surface-sunken px-4 py-3 overflow-x-auto font-mono text-xs leading-[1.8] text-ink-code animate-reveal"
          dangerouslySetInnerHTML={{ __html: highlightCode(code, language) }}
        />
      )}
    </div>
  );
};
