import { useCallback, useEffect, useState } from "react";

/**
 * Arrow-key navigation for a popover list.
 *
 * Every menu in the studio declared `role="menu"` and then handled nothing but
 * Escape, so they were mouse-only — you could open the model picker from the
 * keyboard and then not choose anything with it. Screen readers were told there
 * was a menu and given no way to walk it.
 *
 * The behaviour here is the platform one, and the details are the point:
 *
 *   - **Nothing is highlighted until you press a key.** Opening a menu with the
 *     first row pre-selected means an accidental Enter picks something. `-1`
 *     is the resting state, and the first ArrowDown lands on row 0.
 *   - **Movement wraps**, because a list you cannot get out of the bottom of is
 *     slower than one you can.
 *   - **Disabled rows are skipped**, not merely un-clickable — walking onto a
 *     dead row and pressing Enter should never be a no-op the operator has to
 *     diagnose.
 *   - **Listeners are capturing.** A menu opened over a focused textarea has to
 *     take the arrows before the field scrolls its own caret.
 */
export interface MenuKeyboardOptions {
  open: boolean;
  /** Number of rows. Movement wraps within it. */
  count: number;
  onSelect: (index: number) => void;
  onClose: () => void;
  /** Rows that cannot be landed on. */
  isDisabled?: (index: number) => boolean;
}

export interface MenuKeyboardResult {
  /** The highlighted row, or -1 when the keyboard has not been used yet. */
  activeIndex: number;
  setActiveIndex: (index: number) => void;
}

export function useMenuKeyboard({
  open,
  count,
  onSelect,
  onClose,
  isDisabled,
}: MenuKeyboardOptions): MenuKeyboardResult {
  const [activeIndex, setActiveIndex] = useState(-1);

  // Reopening starts clean rather than resuming wherever the last visit ended.
  useEffect(() => {
    if (!open) setActiveIndex(-1);
  }, [open]);

  // A menu whose list shrank under the cursor must not keep a stale index.
  useEffect(() => {
    setActiveIndex((current) => (current >= count ? count - 1 : current));
  }, [count]);

  const step = useCallback(
    (from: number, direction: 1 | -1) => {
      if (count === 0) return -1;
      let next = from;
      for (let attempt = 0; attempt < count; attempt += 1) {
        next = (next + direction + count) % count;
        if (!isDisabled?.(next)) return next;
      }
      return -1; // every row is disabled
    },
    [count, isDisabled],
  );

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          event.stopPropagation();
          setActiveIndex((current) => step(current === -1 ? -1 : current, 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          event.stopPropagation();
          setActiveIndex((current) => step(current === -1 ? 0 : current, -1));
          break;
        case "Home":
          event.preventDefault();
          setActiveIndex(step(-1, 1));
          break;
        case "End":
          event.preventDefault();
          setActiveIndex(step(0, -1));
          break;
        case "Enter":
          // Only claim Enter once a row is actually highlighted, so opening a
          // menu and hitting Enter does not fire an arbitrary first item.
          setActiveIndex((current) => {
            if (current >= 0 && !isDisabled?.(current)) {
              event.preventDefault();
              event.stopPropagation();
              onSelect(current);
            }
            return current;
          });
          break;
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          onClose();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, step, onSelect, onClose, isDisabled]);

  return { activeIndex, setActiveIndex };
}
