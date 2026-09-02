import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const DEFAULT_THRESHOLD = 48;

export interface StickyScroll<T extends HTMLElement> {
  ref: React.RefObject<T | null>;
  /** True while the view is following new content. */
  isPinned: boolean;
  /** True when there is content below the fold — use it to offer a jump control. */
  hasOverflowBelow: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

/**
 * Follows streaming content, but yields to the reader.
 *
 * While the viewport sits at the bottom, new content scrolls into view. The
 * moment the user scrolls up they are left alone — no snapping back mid-read —
 * and following resumes only once they return to the bottom themselves.
 */
export function useStickyScroll<T extends HTMLElement>(
  dependency: unknown,
  options: { threshold?: number; enabled?: boolean } = {},
): StickyScroll<T> {
  const { threshold = DEFAULT_THRESHOLD, enabled = true } = options;
  const ref = useRef<T>(null);
  const pinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);
  const [hasOverflowBelow, setHasOverflowBelow] = useState(false);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const pinned = distance <= threshold;
    pinnedRef.current = pinned;
    setIsPinned(pinned);
    setHasOverflowBelow(distance > threshold);
  }, [threshold]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => element.removeEventListener("scroll", measure);
  }, [measure]);

  // Runs before paint so following content never shows a visible jump.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled || !pinnedRef.current) {
      measure();
      return;
    }
    element.scrollTop = element.scrollHeight;
    measure();
  }, [dependency, enabled, measure]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = ref.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    pinnedRef.current = true;
    setIsPinned(true);
    setHasOverflowBelow(false);
  }, []);

  return { ref, isPinned, hasOverflowBelow, scrollToBottom };
}
