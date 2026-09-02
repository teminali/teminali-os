import React from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "tab" | "pill";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  shortcut?: string;
  loading?: boolean;
  active?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-ink-high font-semibold hover:bg-accent-hover border border-transparent shadow-sm active:scale-[0.98] disabled:opacity-40 disabled:bg-surface-chip disabled:text-ink-placeholder",
  secondary:
    "bg-surface text-ink-prose hover:text-ink-high hover:bg-surface-hover border border-edge hover:border-edge-strong shadow-sm active:scale-[0.98] disabled:opacity-40",
  ghost:
    "bg-transparent text-ink-muted hover:text-ink-high hover:bg-surface-chip border border-transparent disabled:opacity-30",
  danger:
    "bg-danger/15 text-danger hover:bg-danger/25 border border-danger/30 hover:border-danger/50 shadow-sm active:scale-[0.98] disabled:opacity-40",
  tab:
    "bg-transparent text-ink-muted hover:text-ink-high hover:bg-surface-chip border border-transparent rounded-lg font-medium",
  pill:
    "rounded-full bg-surface-chip text-ink-dim hover:text-ink-high hover:bg-surface-hover border border-edge text-3xs font-mono transition-all",
};

const activeStyles: Partial<Record<ButtonVariant, string>> = {
  tab: "bg-accent/15 text-accent border border-accent/30 shadow-sm font-semibold",
  secondary: "bg-accent/15 text-accent border-accent/40 shadow-sm font-semibold",
  ghost: "bg-surface-hover text-ink-high font-medium",
  pill: "bg-accent/20 text-accent border-accent/40 font-bold",
};

const sizeStyles: Record<ButtonSize, string> = {
  xs: "px-2 py-0.5 text-3xs gap-1 rounded-md min-h-[22px]",
  sm: "px-2.5 py-1 text-xs gap-1.5 rounded-lg min-h-[28px]",
  md: "px-3.5 py-1.5 text-xs gap-2 rounded-xl min-h-[34px]",
  lg: "px-4 py-2 text-sm gap-2.5 rounded-xl min-h-[40px]",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = "secondary",
      size = "sm",
      icon,
      shortcut,
      loading = false,
      active = false,
      className = "",
      disabled,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`inline-flex items-center justify-center font-sans transition-all duration-100 select-none cursor-pointer disabled:cursor-not-allowed ${
          variantStyles[variant]
        } ${active && activeStyles[variant] ? activeStyles[variant] : ""} ${
          sizeStyles[size]
        } ${className}`}
        {...props}
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-current" />
        ) : (
          icon && <span className="flex-shrink-0">{icon}</span>
        )}
        {children && <span>{children}</span>}
        {shortcut && (
          <span className="text-4xs font-mono text-ink-muted bg-surface-chip px-1 py-0.2 rounded border border-edge ml-auto">
            {shortcut}
          </span>
        )}
      </button>
    );
  }
);

Button.displayName = "Button";
