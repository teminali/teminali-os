import React, { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, FileText } from "lucide-react";
import { SKILLS_LIST } from "../../store/studioStore";
import { WorkspaceService } from "../../services/workspaceService";
import type { FileItem } from "../../types";
import {
  scoreMatch,
  type ActiveTrigger,
  type ComposerMenuItem,
} from "../../utils/composerTrigger";

export type { ActiveTrigger, ComposerMenuItem, TriggerKind } from "../../utils/composerTrigger";

/**
 * The `/` and `@` menus the composer's placeholder has always advertised.
 *
 * "Plan, Build, / for skills, @ for context" sat under the caret for months
 * with nothing behind either character. This is that promise, kept: `/` picks a
 * specialist skill, `@` picks a file from the workspace to hand the model as
 * context.
 *
 * Two rules make a trigger menu feel right rather than intrusive:
 *
 *   1. **Only trigger at a word boundary.** An `@` inside `user@host` or a `/`
 *      inside `src/App.tsx` is punctuation, not a command. The menu opens only
 *      when the character starts a token.
 *   2. **The keyboard drives it.** Arrows move, Enter and Tab accept, Escape
 *      dismisses — and while it is open those keys belong to the menu, so Enter
 *      picks an item instead of sending a half-written prompt.
 */

/** Flattens the workspace tree to the files a person could mean. */
function flatten(items: FileItem[], into: FileItem[] = []): FileItem[] {
  for (const item of items) {
    if (item.type === "file") into.push(item);
    if (item.children?.length) flatten(item.children, into);
  }
  return into;
}

export interface ComposerMenuProps {
  trigger: ActiveTrigger;
  /** Index of the highlighted row, owned by the composer so keys can move it. */
  activeIndex: number;
  onItems: (items: ComposerMenuItem[]) => void;
  onSelect: (item: ComposerMenuItem) => void;
}

export const ComposerMenu: React.FC<ComposerMenuProps> = ({ trigger, activeIndex, onItems, onSelect }) => {
  const [files, setFiles] = useState<FileItem[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // The tree is fetched once per opening of a file trigger, not per keystroke.
  useEffect(() => {
    if (trigger.kind !== "file") return;
    const controller = new AbortController();
    void WorkspaceService.listFiles(controller.signal)
      .then((workspace) => {
        if (!controller.signal.aborted) setFiles(flatten(workspace.files));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFiles([]);
      });
    return () => controller.abort();
  }, [trigger.kind]);

  const items = useMemo<ComposerMenuItem[]>(() => {
    if (trigger.kind === "skill") {
      return SKILLS_LIST.map((skill) => ({
        id: skill.id,
        label: skill.name,
        detail: skill.tagline,
        kind: "skill" as const,
      }))
        .map((item) => ({ item, score: scoreMatch(item.label, trigger.query) }))
        .filter((entry) => entry.score !== null)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 8)
        .map((entry) => entry.item);
    }

    return files
      .map((file) => ({ file, score: scoreMatch(file.path, trigger.query) }))
      .filter((entry) => entry.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 8)
      .map((entry) => ({
        id: entry.file.path,
        label: entry.file.name,
        detail: entry.file.path,
        kind: "file" as const,
      }));
  }, [trigger.kind, trigger.query, files]);

  // The composer needs the list to bound its own arrow-key movement.
  useEffect(() => {
    onItems(items);
  }, [items, onItems]);

  // Keep the highlighted row in view when the arrows walk past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={trigger.kind === "skill" ? "Skills" : "Workspace files"}
      className="lit lit-strong absolute bottom-full mb-2 left-0 z-40 w-[340px] max-h-[280px] overflow-y-auto rounded-xl bg-surface-popover shadow-popover p-1 animate-in"
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          data-active={index === activeIndex}
          // Mousedown, not click: the textarea must not lose focus first, or
          // the caret position the insertion depends on is already gone.
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(item);
          }}
          className={`w-full h-7 px-2.5 rounded-md flex items-center gap-2 text-sm text-left transition-colors duration-ds ease-ds ${
            index === activeIndex ? "bg-surface-active text-ink-strong" : "text-ink-body hover:bg-surface-hover"
          }`}
        >
          {item.kind === "skill" ? (
            <Boxes size={13} className="text-ink-muted flex-shrink-0" />
          ) : (
            <FileText size={13} className="text-ink-muted flex-shrink-0" />
          )}
          <span className="truncate">{item.label}</span>
          {item.detail && (
            <>
              <span className="flex-1" />
              <span className="text-2xs text-ink-soft truncate max-w-[170px]">{item.detail}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
};
