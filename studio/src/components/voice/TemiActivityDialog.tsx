/**
 * The whole of the Teminali OS assistant's visible history — on demand.
 *
 * The assistant has no chat and no panel. Its only standing presence is the
 * one-line process strip under Temi's orb (`AgentActivityTicker`); this dialog
 * is what that line opens when someone wants the detail behind it. That is the
 * entire contract: **nothing here is ever shown unasked**, because a pane that
 * lives on screen becomes a second chat, which is the thing this design exists
 * to remove.
 *
 * Lazy on purpose. A long run produces hundreds of rows and the store keeps
 * fifty; rendering opens at `PAGE` rows and grows by `PAGE` as the operator
 * reaches the end, so opening the dialog mid-run costs one screenful, not the
 * whole feed.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, Square, Terminal, Trash2, X } from "lucide-react";

import { useAssistantActivityStore, type AssistantActivityItem } from "../../store/assistantActivityStore";
import { TeminaliAgentBridge } from "../../services/voice/teminaliAgentBridge";

/** Rows rendered per page. One screenful, then more as you reach the end. */
const PAGE = 20;

/** How close to the bottom edge counts as "reached the end", in pixels. */
const LOAD_MORE_MARGIN = 240;

const TYPE_LABEL: Record<AssistantActivityItem["type"], string> = {
  cmd: "COMMAND",
  edit: "CODE WRITE",
  read: "ANALYSIS",
  test: "TEST",
};

const TYPE_TONE: Record<AssistantActivityItem["type"], string> = {
  cmd: "bg-emerald-500/15 text-emerald-400",
  edit: "bg-amber-500/15 text-amber-400",
  read: "bg-emerald-500/15 text-emerald-400",
  test: "bg-violet-500/15 text-violet-400",
};

const ActivityRow: React.FC<{ item: AssistantActivityItem }> = ({ item }) => (
  <div className="space-y-1.5 rounded-xl border border-[#282828] bg-[#191919] p-3 transition-colors hover:border-[#363636]">
    <div className="flex items-center justify-between text-[10px]">
      <span className={`rounded px-1.5 py-0.5 font-semibold tracking-wide ${TYPE_TONE[item.type]}`}>
        {TYPE_LABEL[item.type]}
      </span>
      <span className="text-[#666666]">{item.timeLabel || "Just now"}</span>
    </div>

    {item.type === "cmd" && (
      <>
        <div className="flex items-center gap-1.5 overflow-x-auto rounded border border-[#222222] bg-[#0c0c0c] p-1.5 font-mono text-[11px] text-[#00d66f]">
          <span className="text-[#737373]">$</span>
          <span className="whitespace-pre">{item.cmd || "frontier-run"}</span>
        </div>
        <div
          className={`flex items-center gap-1 text-[10px] ${
            item.status === "failed" ? "text-rose-400" : "text-emerald-400"
          }`}
        >
          {item.status !== "failed" && <Check size={11} strokeWidth={2.5} />}
          <span>{item.result || "Exit code 0"}</span>
        </div>
      </>
    )}

    {item.type === "edit" && (
      <>
        <div className="flex items-center gap-1.5 truncate font-mono text-[11px] text-[#e5e5e5]">
          <span className="rounded bg-[#333333] px-1 py-[1px] text-[9px] font-bold text-[#f5f5f5]">
            {item.badge?.toUpperCase() || "MODIFY"}
          </span>
          <span className="truncate" title={item.file}>
            {item.file ? item.file.split("/").pop() : "file.ts"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#888888]">
          {item.plus && <span className="font-mono text-emerald-400">{item.plus}</span>}
          {item.minus && <span className="font-mono text-rose-400">{item.minus}</span>}
          {item.desc && <span className="truncate">{item.desc}</span>}
        </div>
      </>
    )}

    {(item.type === "read" || item.type === "test") && (
      <>
        <div className="flex items-center gap-1.5 truncate font-mono text-[11px] text-[#e5e5e5]">
          <span className="rounded bg-emerald-950 px-1 py-[1px] text-[9px] font-bold text-emerald-300">
            {item.type === "test" ? "TEST" : "READ"}
          </span>
          <span className="truncate" title={item.file}>
            {item.file ? item.file.split("/").pop() : "file.ts"}
          </span>
        </div>
        {item.desc && <div className="truncate text-[10px] text-[#888888]">{item.desc}</div>}
      </>
    )}
  </div>
);

export interface TemiActivityDialogProps {
  open: boolean;
  onClose: () => void;
}

export const TemiActivityDialog: React.FC<TemiActivityDialogProps> = ({ open, onClose }) => {
  const items = useAssistantActivityStore((state) => state.items);
  const isTaskRunning = useAssistantActivityStore((state) => state.isTaskRunning);
  const currentTaskPrompt = useAssistantActivityStore((state) => state.currentTaskPrompt);
  const latestProgress = useAssistantActivityStore((state) => state.latestProgress);
  const activeEngine = useAssistantActivityStore((state) => state.activeEngine);
  const clearActivity = useAssistantActivityStore((state) => state.clearActivity);

  const [visible, setVisible] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Every opening starts at the top with one page. Carrying the previous
  // scroll depth across openings would restore a position in a feed that has
  // since been rewritten from the head.
  useEffect(() => {
    if (open) {
      setVisible(PAGE);
      scrollRef.current?.scrollTo({ top: 0 });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_MARGIN) {
      setVisible((count) => (count >= items.length ? count : count + PAGE));
    }
  }, [items.length]);

  if (!open) return null;

  const shown = items.slice(0, visible);
  const remaining = items.length - shown.length;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Assistant activity"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-[#2b2b2b] bg-[#141414] shadow-[0_24px_80px_rgba(0,0,0,0.75)]"
      >
        <header className="flex h-12 flex-shrink-0 items-center justify-between border-b border-[#242424] px-4">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium tracking-tight text-[#ececec]">Activity</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                isTaskRunning
                  ? "animate-pulse border border-emerald-500/30 bg-emerald-500/20 text-emerald-400"
                  : "bg-[#262626] text-[#a3a3a3]"
              }`}
            >
              {isTaskRunning ? "WORKING" : items.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {items.length > 0 && (
              <button
                type="button"
                onClick={clearActivity}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[#737373] transition-colors hover:bg-[#222222] hover:text-[#a3a3a3]"
              >
                <Trash2 size={12} />
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1.5 text-[#737373] transition-colors hover:bg-[#262626] hover:text-[#f5f5f5]"
              title="Close activity"
              aria-label="Close activity"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="custom-scrollbar flex-1 space-y-2 overflow-y-auto p-3"
        >
          {isTaskRunning && (
            <div className="space-y-1.5 rounded-xl border border-[#00bf63]/40 bg-[#0a2a1a] p-3 shadow-[0_0_12px_rgba(0,191,99,0.18)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 animate-ping rounded-full bg-emerald-400" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                    {activeEngine} running
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => TeminaliAgentBridge.stopCurrentTask()}
                  className="flex items-center gap-1 rounded border border-rose-800/60 bg-rose-950/80 px-2 py-0.5 text-[10px] font-medium text-rose-300 transition-colors hover:bg-rose-900"
                  title="Stop background assistant execution"
                >
                  <Square size={9} fill="currentColor" />
                  <span>Stop</span>
                </button>
              </div>
              {currentTaskPrompt && (
                <p className="line-clamp-2 text-[11px] font-medium leading-tight text-[#f5f5f5]">
                  “{currentTaskPrompt}”
                </p>
              )}
              {latestProgress && (
                <div className="flex items-center gap-1 pt-0.5 font-mono text-[10px] text-emerald-300/90">
                  <Terminal size={10} className="flex-shrink-0" />
                  <span className="truncate">{latestProgress}</span>
                </div>
              )}
            </div>
          )}

          {items.length === 0 && !isTaskRunning ? (
            <div className="py-16 text-center text-xs text-[#666666]">
              Nothing has run yet. What the assistant does will appear here.
            </div>
          ) : (
            shown.map((item) => <ActivityRow key={item.id} item={item} />)
          )}

          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setVisible((count) => count + PAGE)}
              className="w-full rounded-lg py-2 text-[11px] text-[#737373] transition-colors hover:bg-[#1c1c1c] hover:text-[#a3a3a3]"
            >
              {remaining} earlier {remaining === 1 ? "step" : "steps"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
