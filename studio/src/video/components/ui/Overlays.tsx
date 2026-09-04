/* ═══════════════════════════════════════════════════════════════════
   The two surfaces the editor was already talking to and nobody was
   drawing.

   `uiStore` has carried `contextMenu` and `toasts` since the slice was
   ported, and eleven call sites push to them — every track header's
   right-click menu, every clip's right-click menu, and the whole
   result path of beat detection ("142 beats detected", "Beat detection
   failed", and its progress toast). Nothing in the panel subscribed to
   either, so all of it went nowhere: right-click opened the browser's
   own menu and a failed analysis reported success by saying nothing.

   They are here rather than in the app's shell because the classes
   they wear (`.glass`, `.row-item`, `.chip`) are scoped to
   `.video-workspace`. Rendered outside the pane they would be unstyled
   divs; rendered inside it they are the panel's own vocabulary.
   ═══════════════════════════════════════════════════════════════════ */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useUiStore, type ContextMenuItem } from '../../store/uiStore';
import { AlertCircle, CheckCircle2, Info, Loader2, X } from './icons';

/* ── Context menu ───────────────────────────────────────────────── */

const MENU_MARGIN = 8;

export const ContextMenu: React.FC = () => {
  const menu = useUiStore((s) => s.contextMenu);
  const close = useUiStore((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  /* Flip rather than clip. A menu opened near the pane's bottom edge is
     the common case here — the track headers are at the bottom of a
     short panel — and a menu that runs off screen is a menu with items
     nobody can reach. Measured after mount because the item count, and
     therefore the height, is decided by the caller. */
  useLayoutEffect(() => {
    if (!menu) { setPos(null); return; }
    const el = ref.current;
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 160;
    setPos({
      left: Math.max(MENU_MARGIN, Math.min(menu.x, window.innerWidth - w - MENU_MARGIN)),
      top: Math.max(MENU_MARGIN, Math.min(menu.y, window.innerHeight - h - MENU_MARGIN)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // `capture` so a click that also lands on a button still closes the menu.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', close);
    };
  }, [menu, close]);

  if (!menu) return null;

  return (
    <div
      ref={ref}
      role="menu"
      className="video-menu glass rounded-squircle-md py-1 animate-fade-in"
      style={{
        position: 'fixed',
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        // Hidden for the one frame between mount and measurement, so the
        // menu never appears at an off-screen position and jumps.
        visibility: pos ? 'visible' : 'hidden',
        zIndex: 3000,
      }}
    >
      {menu.items.map((item) => (
        <MenuRow key={item.id} item={item} onDone={close} />
      ))}
    </div>
  );
};

const MenuRow: React.FC<{ item: ContextMenuItem; onDone: () => void }> = ({ item, onDone }) => {
  const Icon = item.icon;
  return (
    <>
      {item.separatorBefore && <div className="hairline my-1" />}
      <button
        role="menuitem"
        disabled={item.disabled}
        onClick={() => { if (item.disabled) return; item.onSelect(); onDone(); }}
        className={`video-menu-item ${item.danger ? 'is-danger' : ''}`}
      >
        {Icon ? <Icon className="w-3.5 h-3.5 flex-shrink-0" /> : <span className="w-3.5 flex-shrink-0" />}
        <span className="flex-1 truncate text-left">{item.label}</span>
        {item.shortcut && <span className="kbd">{item.shortcut}</span>}
      </button>
    </>
  );
};

/**
 * Open a menu anchored to a control rather than to a cursor.
 *
 * `openContextMenu` takes viewport coordinates because right-click gives
 * it viewport coordinates. An overflow button has no cursor to anchor
 * to — it has a rectangle — and every toolbar that grew a "⋯" was about
 * to re-derive the same `getBoundingClientRect()` corner by hand.
 */
export function useAnchoredMenu() {
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  return React.useCallback(
    (e: React.MouseEvent<HTMLElement>, items: ContextMenuItem[], align: 'left' | 'right' = 'right') => {
      const rect = e.currentTarget.getBoundingClientRect();
      openContextMenu(align === 'right' ? rect.right : rect.left, rect.bottom + 4, items);
    },
    [openContextMenu]
  );
}

/* ── Toasts ─────────────────────────────────────────────────────── */

const TOAST_ICON = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
  progress: Loader2,
} as const;

export const Toasts: React.FC = () => {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    /* Bottom-centre, over the timeline. Top-right is where the host's own
       notifications land, and two stacks in one corner is one stack that
       lies about who is speaking. */
    <div className="video-toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = TOAST_ICON[t.kind];
        return (
          <div key={t.id} className={`video-toast is-${t.kind} animate-slide-up`}>
            <Icon className={`w-4 h-4 flex-shrink-0 ${t.kind === 'progress' ? 'animate-spin' : ''}`} />
            <div className="min-w-0 flex-1">
              <div className="text-ui-sm font-medium text-spectrum-text truncate">{t.title}</div>
              {t.detail && (
                <div className="text-ui-xs text-spectrum-textDim truncate">{t.detail}</div>
              )}
              {t.kind === 'progress' && (
                <div className="video-toast-track">
                  <div className="video-toast-fill" style={{ width: `${t.progress ?? 0}%` }} />
                </div>
              )}
            </div>
            {t.action && (
              /* Taking the offer dismisses the toast, because the thing it
                 offered has happened and a notice that outlives its own
                 button is just clutter over the timeline. */
              <button
                onClick={() => {
                  t.action?.onSelect();
                  dismiss(t.id);
                }}
                className="pro-btn px-2 h-6 flex-shrink-0 text-ui-xs whitespace-nowrap"
              >
                {t.action.label}
              </button>
            )}
            <button
              onClick={() => dismiss(t.id)}
              className="pro-btn w-5 h-5 flex-shrink-0"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
