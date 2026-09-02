import React, { useCallback, useEffect, useRef, useState } from "react";
import { TerminalService } from "../../../services/terminalService";
import { StatusDot } from "../../ui";
import type { PanelTab } from "../../../store/panelStore";

/**
 * A real terminal, not a mock.
 *
 * Commands go to the gateway's /api/terminal/exec, which streams stdout and
 * stderr back as they arrive and always ends with a genuine exit status. That
 * last part matters: the pane reports what actually happened, including a
 * non-zero exit, rather than printing output and implying success.
 *
 * It is a line-oriented runner rather than a PTY, so there is no curses, no
 * colour and no interactive prompt. That is a deliberate limit of the gateway
 * contract and the pane says so when a command looks interactive.
 */

interface Line {
  id: number;
  kind: "stdout" | "stderr" | "command" | "meta";
  text: string;
}

const INTERACTIVE = /^\s*(vim?|nano|emacs|less|more|top|htop|ssh|tmux|screen|watch)\b/;

export const TerminalPane: React.FC<{ panel: PanelTab }> = ({ panel }) => {
  const [lines, setLines] = useState<Line[]>([
    { id: 0, kind: "meta", text: `frontier — ${panel.cwd ?? "workspace root"} — zsh` },
  ]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  const append = useCallback((kind: Line["kind"], text: string) => {
    setLines((previous) => {
      const next = [...previous, { id: nextId.current++, kind, text }];
      // Keep the buffer bounded; a build log can run to tens of thousands of
      // lines and the DOM should not carry all of them.
      return next.length > 2000 ? next.slice(next.length - 2000) : next;
    });
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  const run = useCallback(
    async (command: string) => {
      const trimmed = command.trim();
      if (!trimmed || running) return;

      append("command", trimmed);
      setHistory((previous) => [...previous.filter((entry) => entry !== trimmed), trimmed]);
      setHistoryIndex(null);
      setInput("");

      if (trimmed === "clear") {
        setLines([]);
        return;
      }
      if (INTERACTIVE.test(trimmed)) {
        append("stderr", `${trimmed.split(/\s+/)[0]} needs an interactive terminal, which this pane does not provide.`);
        return;
      }

      setRunning(true);
      setExitCode(null);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const exit = await TerminalService.run(trimmed, {
          ...(panel.cwd ? { cwd: panel.cwd } : {}),
          signal: controller.signal,
          onOutput: (chunk) => append(chunk.type, chunk.data.replace(/\n$/, "")),
        });
        setExitCode(exit.code);
        if (exit.truncated) append("meta", `— output truncated (${exit.reason ?? "limit reached"}) —`);
        if (exit.code !== 0) {
          append("meta", `exited ${exit.code}${exit.signal ? ` (${exit.signal})` : ""} in ${(exit.durationMs / 1000).toFixed(2)}s`);
        }
      } catch (error) {
        if (!controller.signal.aborted) append("stderr", (error as Error).message);
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [append, panel.cwd, running],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void run(input);
      return;
    }
    if (event.key === "c" && event.ctrlKey) {
      event.preventDefault();
      abortRef.current?.abort();
      append("meta", "^C");
      setRunning(false);
      return;
    }
    // Shell-style history on the arrow keys.
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (history.length === 0) return;
      const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(index);
      setInput(history[index]);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex === null) return;
      const index = historyIndex + 1;
      if (index >= history.length) {
        setHistoryIndex(null);
        setInput("");
      } else {
        setHistoryIndex(index);
        setInput(history[index]);
      }
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col" onClick={() => inputRef.current?.focus()}>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 pt-4 font-mono text-xs leading-[1.75]">
        {lines.map((line) => (
          <div
            key={line.id}
            className={
              line.kind === "stderr"
                ? "text-danger whitespace-pre-wrap break-words"
                : line.kind === "meta"
                  ? "text-ink-soft whitespace-pre-wrap break-words"
                  : line.kind === "command"
                    ? "text-ink-code whitespace-pre-wrap break-words"
                    : "text-ink-code whitespace-pre-wrap break-words"
            }
          >
            {line.kind === "command" ? (
              <>
                <span className="text-success">➜</span> <span className="text-info">frontier</span> {line.text}
              </>
            ) : (
              line.text
            )}
          </div>
        ))}

        {/* The live prompt sits in the scroll flow so it never floats away. */}
        <div className="flex items-center gap-2 text-ink-code">
          <span className="text-success">➜</span>
          <span className="text-info">frontier</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={running}
            spellCheck={false}
            autoComplete="off"
            aria-label="Terminal command"
            className="flex-1 bg-transparent outline-none text-ink-code disabled:opacity-50 font-mono"
          />
          {running && <span className="w-1.5 h-3.5 bg-ink-code animate-caret" aria-hidden />}
        </div>
        <div className="h-4" />
      </div>

      <div className="flex-shrink-0 px-4 py-2.5 border-t border-edge-chrome flex items-center gap-2 font-mono text-2xs text-ink-placeholder">
        <StatusDot tone={running ? "accent" : exitCode !== null && exitCode !== 0 ? "danger" : "success"} pulse={running} />
        {running ? "running — Ctrl+C to cancel" : exitCode !== null ? `zsh · exit ${exitCode}` : "zsh · ready"}
      </div>
    </div>
  );
};
