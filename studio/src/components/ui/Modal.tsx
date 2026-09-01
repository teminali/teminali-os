import React, { useEffect } from "react";
import { X } from "lucide-react";

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
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-20 bg-black/80 backdrop-blur-md p-3 select-none font-sans animate-in fade-in duration-100"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`w-full ${sizeStyles[size]} bg-[#141720] border border-white/10 rounded-2xl shadow-[0_30px_90px_rgba(0,0,0,0.9)] overflow-hidden flex flex-col animate-in zoom-in-95 duration-100 ${className}`}
      >
        {/* Modal Header */}
        {(title || showCloseButton) && (
          <header className="px-4 py-3 bg-[#0d1017] border-b border-white/5 flex items-center justify-between gap-3 flex-shrink-0">
            <div className="flex items-center gap-2.5 truncate">
              {icon && <span className="flex-shrink-0">{icon}</span>}
              <div className="flex flex-col truncate">
                {title && (
                  <h3 className="text-xs font-semibold text-white truncate tracking-tight">
                    {title}
                  </h3>
                )}
                {subtitle && (
                  <p className="text-3xs text-gray-400 font-normal truncate">{subtitle}</p>
                )}
              </div>
            </div>

            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
                title="Close (Esc)"
              >
                <X size={14} />
              </button>
            )}
          </header>
        )}

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>

        {/* Modal Footer */}
        {footer && (
          <footer className="px-4 py-2.5 bg-[#0a0c12] border-t border-white/5 flex items-center justify-between text-xs flex-shrink-0">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
};
