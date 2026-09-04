import React, { useMemo } from "react";
import { Check, ChevronDown, FilePlus2, Loader2, RotateCcw, X } from "lucide-react";
import { useChangeStore } from "../../store/changeStore";
import { diffChunks } from "../../services/diff";
import { splitPath, type FileChange } from "../../services/changeSet";

/**
 * The review dock — what the assistant changed, and the two words that settle it.
 *
 * It sits directly above the composer because that is where the operator's eyes
 * already are when a turn ends, and it is the last thing between a proposed
 * edit and the next prompt. It is not a modal: reviewing a change must not stop
 * you reading the reply that explains it.
 *
 * Accept is bookkeeping — the bytes are already on disk. Reject is the real
 * operation: it writes the captured pre-edit content back, or removes the file
 * if the assistant created it. Nothing here is optimistic; a row disappears
 * only after the disk agrees.
 */

export const ChangeReviewDock: React.FC<{ width?: "column" | "fill" }> = ({ width = "column" }) => {
  const changes = useChangeStore((state) => state.changes);
  const busyPath = useChangeStore((state) => state.busyPath);
  const error = useChangeStore((state) => state.error);
  const expanded = useChangeStore((state) => state.expanded);
  const openPath = useChangeStore((state) => state.openPath);
  const { accept, acceptAll, reject, rejectAll, setExpanded, toggleOpen } = useChangeStore.getState();

  const totals = useMemo(
    () => ({
      files: changes.length,
      additions: changes.reduce((sum, change) => sum + change.additions, 0),
      deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
    }),
    [changes],
  );

  if (changes.length === 0) return null;

  return (
    <section
      aria-label="Changed files awaiting review"
      className={`w-full ${width === "column" ? "max-w-composer" : ""} rounded-xl border border-edge bg-surface-sunken overflow-hidden animate-in`}
    >
      <header className="h-9 flex items-center gap-2 pl-2 pr-1.5">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 h-6 px-1 rounded-md text-xs text-ink-dim hover:text-ink-high transition-colors duration-ds ease-ds"
        >
          <ChevronDown
            size={12}
            className={`text-ink-faint transition-transform duration-ds ease-ds ${expanded ? "" : "-rotate-90"}`}
          />
          <span className="font-medium">
            {totals.files} {totals.files === 1 ? "file" : "files"} changed
          </span>
          <Stat additions={totals.additions} deletions={totals.deletions} />
        </button>

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => void rejectAll()}
          disabled={busyPath !== null}
          className="h-6 px-2.5 rounded-md text-xs text-ink-muted hover:text-danger hover:bg-danger/10 disabled:opacity-40 transition-colors duration-ds ease-ds"
        >
          Reject all
        </button>
        <button
          type="button"
          onClick={acceptAll}
          disabled={busyPath !== null}
          className="h-6 px-2.5 rounded-md text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40 transition-colors duration-ds ease-ds"
        >
          Accept all
        </button>
      </header>

      {error && <p className="px-3 pb-2 text-2xs text-danger">{error}</p>}

      {expanded && (
        <ul className="border-t border-edge/60 max-h-56 overflow-y-auto">
          {changes.map((change) => (
            <ChangeRow
              key={change.path}
              change={change}
              busy={busyPath === change.path}
              open={openPath === change.path}
              onToggle={() => toggleOpen(change.path)}
              onAccept={() => accept(change.path)}
              onReject={() => void reject(change.path)}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

const Stat: React.FC<{ additions: number; deletions: number; approximate?: boolean }> = ({
  additions,
  deletions,
  approximate = false,
}) => (
  <span className="font-mono text-2xs tabular-nums flex items-center gap-1.5" title={approximate ? "Estimated: the file is too large to diff exactly" : undefined}>
    {additions > 0 && <span className="text-success">{approximate ? "≈" : ""}+{additions}</span>}
    {deletions > 0 && <span className="text-danger">{approximate ? "≈" : ""}−{deletions}</span>}
  </span>
);

const ChangeRow: React.FC<{
  change: FileChange;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onAccept: () => void;
  onReject: () => void;
}> = ({ change, busy, open, onToggle, onAccept, onReject }) => {
  const { name, directory } = splitPath(change.path);

  return (
    <li className="border-b border-edge/40 last:border-b-0">
      <div className="group h-8 flex items-center gap-2 pl-2.5 pr-1.5 hover:bg-surface-hover/60 transition-colors duration-ds ease-ds">
        <button type="button" onClick={onToggle} className="flex-1 min-w-0 flex items-center gap-2 text-left">
          {change.existedBefore ? (
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${busy ? "bg-warning" : "bg-accent"}`} />
          ) : (
            <FilePlus2 size={11} className="text-accent flex-shrink-0" />
          )}
          <Stat additions={change.additions} deletions={change.deletions} approximate={change.approximate} />
          <span className="text-xs text-ink-high truncate">{name}</span>
          {directory && <span className="text-2xs text-ink-faint truncate hidden sm:inline">{directory}</span>}
        </button>

        {busy ? (
          <Loader2 size={12} className="animate-spin text-ink-faint mr-1.5" />
        ) : (
          <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-ds ease-ds">
            <button
              type="button"
              onClick={onReject}
              title={change.existedBefore ? "Reject — restore the file as it was" : "Reject — remove the file the assistant created"}
              className="w-6 h-6 rounded-md flex items-center justify-center text-ink-muted hover:text-danger hover:bg-danger/10 transition-colors duration-ds ease-ds"
            >
              {change.existedBefore ? <RotateCcw size={12} /> : <X size={12} />}
            </button>
            <button
              type="button"
              onClick={onAccept}
              title="Accept — keep the change"
              className="w-6 h-6 rounded-md flex items-center justify-center text-ink-muted hover:text-success hover:bg-success/10 transition-colors duration-ds ease-ds"
            >
              <Check size={12} />
            </button>
          </span>
        )}
      </div>

      {open && <ChangeDiff change={change} />}
    </li>
  );
};

/**
 * The unified diff, inline. Bounded in height so a 600-line rewrite does not
 * push the composer off the screen — the file itself is one click away in the
 * editor for anything longer than a glance.
 */
const ChangeDiff: React.FC<{ change: FileChange }> = ({ change }) => {
  const chunks = useMemo(() => diffChunks(change.before, change.after), [change.before, change.after]);

  return (
    <div className="max-h-64 overflow-auto bg-frame-bot border-t border-edge/40 animate-reveal">
      {chunks.map((chunk) => (
        <div key={chunk.id}>
          <div className="sticky top-0 px-2.5 py-1 font-mono text-3xs text-ink-faint bg-frame-bot/95 backdrop-blur-sm">
            {chunk.header}
          </div>
          {chunk.lines.map((line, index) => (
            <div
              key={index}
              className={`flex font-mono text-3xs leading-[1.7] ${
                line.type === "addition"
                  ? "bg-success/[0.08] text-success"
                  : line.type === "deletion"
                    ? "bg-danger/[0.08] text-danger"
                    : "text-ink-code/70"
              }`}
            >
              <span className="w-9 flex-shrink-0 text-right pr-2 text-ink-disabled tabular-nums select-none">
                {line.type === "addition" ? line.newLineNumber : line.oldLineNumber}
              </span>
              <span className="w-3 flex-shrink-0 select-none">
                {line.type === "addition" ? "+" : line.type === "deletion" ? "−" : " "}
              </span>
              <span className="whitespace-pre-wrap break-words pr-3">{line.content}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};
