import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/**
 * Track an element's content-box size via ResizeObserver.
 * Returns a ref to attach and the live size (0×0 until first measurement).
 *
 * The effect deliberately has NO dependency array, and that is the whole
 * correctness argument: it must run after every render so that it can notice
 * the ref changing hands. A mount-only effect measures whatever `ref.current`
 * happens to be at mount, and for any consumer that renders `null` first there
 * is nothing there — the observer is never attached and the size stays 0×0
 * for the life of the component. `RecorderModal` is exactly that shape (it
 * returns `null` while the dialog is shut), which pinned its measured width at
 * 0, its density tier at `xs`, and left the capture options — the camera
 * preview and the microphone meter — permanently behind a summon button on a
 * 1024px-wide dialog with room for them four times over.
 *
 * The per-render cost is one reference comparison; the observer is rebuilt
 * only when the element itself is new.
 */
export function useMeasure<T extends HTMLElement = HTMLDivElement>(): [
  React.RefObject<T | null>,
  Size,
] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const observed = useRef<T | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === observed.current) return;

    observer.current?.disconnect();
    observer.current = null;
    observed.current = el;

    const update = (width: number, height: number) => {
      setSize((prev) =>
        Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5
          ? prev
          : { width, height }
      );
    };

    // The element went away: report nothing rather than a stale size, so a
    // consumer that seats a rail on width does not seat it against a box that
    // is no longer laid out.
    if (!el) {
      update(0, 0);
      return;
    }

    update(el.clientWidth, el.clientHeight);

    const next = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      update(box.width, box.height);
    });

    next.observe(el);
    observer.current = next;
  });

  // Unmount is the one moment the loop above cannot see.
  useLayoutEffect(() => () => {
    observer.current?.disconnect();
    observer.current = null;
    observed.current = null;
  }, []);

  return [ref, size];
}

/**
 * Imperative pointer-drag helper.
 *
 * Captures the pointer, streams deltas, and guarantees the `onEnd` callback
 * fires exactly once — including when the drag is cancelled with Escape.
 */
export interface DragHandlers {
  onStart?: (e: React.PointerEvent) => void;
  onMove: (delta: { dx: number; dy: number }, e: PointerEvent) => void;
  onEnd?: (cancelled: boolean) => void;
  cursor?: string;
}

export function useDrag({ onStart, onMove, onEnd, cursor }: DragHandlers) {
  const stateRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });

  return useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      stateRef.current = { x: e.clientX, y: e.clientY, active: true };
      onStart?.(e);

      const prevCursor = document.body.style.cursor;
      if (cursor) document.body.style.cursor = cursor;

      const handleMove = (ev: PointerEvent) => {
        if (!stateRef.current.active) return;
        onMove({ dx: ev.clientX - stateRef.current.x, dy: ev.clientY - stateRef.current.y }, ev);
      };

      const finish = (cancelled: boolean) => {
        if (!stateRef.current.active) return;
        stateRef.current.active = false;
        document.body.style.cursor = prevCursor;
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleCancel);
        window.removeEventListener('keydown', handleKey);
        onEnd?.(cancelled);
      };

      const handleUp = () => finish(false);
      const handleCancel = () => finish(true);
      const handleKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') finish(true);
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleCancel);
      window.addEventListener('keydown', handleKey);
    },
    [onStart, onMove, onEnd, cursor]
  );
}
