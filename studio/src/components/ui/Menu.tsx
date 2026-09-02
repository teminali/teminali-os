import React, { useCallback, useEffect, useRef } from "react";
import { useMenuKeyboard } from "../../hooks/useMenuKeyboard";

/**
 * The floating menu from the design — used by the panel "+" button and the
 * browser omnibox. One implementation, so every popover in the studio has the
 * same edge, shadow, entrance and dismissal behaviour.
 */

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  items?: MenuItem[];
  /** Optional heading above the items. */
  title?: string;
  children?: React.ReactNode;
  className?: string;
  /** Where the popover sits relative to its positioned parent. */
  anchor?: string;
  width?: number | string;
}

export const Menu: React.FC<MenuProps> = ({
  open,
  onClose,
  items,
  title,
  children,
  className = "",
  anchor = "top-2 left-3",
  width = 260,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const rows = items ?? [];

  const select = useCallback(
    (index: number) => {
      const item = rows[index];
      if (!item || item.disabled) return;
      item.onSelect();
      onClose();
    },
    [rows, onClose],
  );

  // Escape is handled by the hook now, along with the arrows.
  const { activeIndex, setActiveIndex } = useMenuKeyboard({
    open,
    count: rows.length,
    onSelect: select,
    onClose,
    isDisabled: (index) => Boolean(rows[index]?.disabled),
  });

  useEffect(() => {
    if (!open) return;
    // Outside-click dismisses. Pointerdown rather than click so the menu closes
    // before the underlying control reacts to the same gesture.
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="menu"
      style={{ width }}
      className={`lit lit-strong absolute ${anchor} z-30 rounded-xl bg-surface-popover shadow-popover p-1.5 animate-in ${className}`}
    >
      {title && <div className="px-3 pt-1.5 pb-2 text-2xs text-ink-faint">{title}</div>}
      {rows.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          // Hover and the arrows drive the same highlight, so moving the mouse
          // after using the keyboard does not leave two rows looking selected.
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => select(index)}
          className={`w-full h-8 px-3 rounded-md flex items-center gap-3 text-sm text-ink-body disabled:opacity-40 transition-colors duration-ds ease-ds ${
            index === activeIndex ? "bg-surface-tab" : "hover:bg-surface-tab"
          }`}
        >
          {item.icon && <span className="text-ink-muted flex-shrink-0 flex">{item.icon}</span>}
          <span className="flex-1 text-left truncate">{item.label}</span>
          {item.shortcut && <span className="font-mono text-2xs text-ink-faint">{item.shortcut}</span>}
        </button>
      ))}
      {children}
    </div>
  );
};
