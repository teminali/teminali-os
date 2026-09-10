import { DialogCloseButton } from "./Primitives";
import React, { useEffect } from "react";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  size?: ModalSize;
  children: React.ReactNode;
  footer?: React.ReactNode;
  showCloseButton?: boolean;
  className?: string;
  /**
   * Replaces the body's own classes rather than adding to them.
   *
   * The default is a padded scroll box, which is right for a form and
   * wrong for a tool that owns its whole surface: the recorder lays out
   * a flex column with its own footers, and 16px of modal padding plus
   * an outer scrollbar puts a second scroll region around it.
   */
  bodyClassName?: string;
}

const sizeStyles: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
  full: "max-w-[95vw] h-[90vh]",
};

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  icon,
  size = "md",
  children,
  footer,
  showCloseButton = true,
  className = "",
  bodyClassName = "flex-1 overflow-y-auto p-4",
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-20 bg-black/70 backdrop-blur-md p-3 select-none font-sans animate-in fade-in duration-100"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`lit lit-strong w-full ${sizeStyles[size]} bg-surface rounded-xl shadow-modal overflow-hidden flex flex-col animate-in zoom-in-95 duration-100 ${className}`}
      >
        {/* Modal Header */}
        {/* `items-stretch`, not `items-center`, because the Windows dialect's
            close is a caption button: a rectangle hard against the corner
            taking the header's full height. The other two dialects carry
            their own padding so the header does not have to choose. */}
        {(title || showCloseButton) && (
          <header className="border-b border-edge flex items-stretch justify-between gap-3 flex-shrink-0">
            <div className="flex items-center gap-2.5 truncate pl-4 py-3 min-w-0">
              {icon && <span className="flex-shrink-0">{icon}</span>}
              <div className="flex flex-col truncate">
                {title && (
                  <h3 className="text-sm text-ink-bright truncate">
                    {title}
                  </h3>
                )}
                {subtitle && (
                  <p className="text-2xs text-ink-muted truncate">{subtitle}</p>
                )}
              </div>
            </div>

            {showCloseButton ? (
              <DialogCloseButton onClose={onClose} flush />
            ) : (
              <span className="w-4 flex-shrink-0" aria-hidden />
            )}
          </header>
        )}

        {/* Modal Body */}
        <div className={bodyClassName}>{children}</div>

        {/* Modal Footer */}
        {footer && (
          <footer className="px-4 py-2.5 border-t border-edge flex items-center justify-between text-sm flex-shrink-0">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
};
