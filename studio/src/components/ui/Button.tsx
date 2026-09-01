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
    "bg-[#FF6C37] text-white font-semibold hover:bg-[#ff7d4d] border border-transparent shadow-sm active:scale-[0.98] disabled:opacity-40 disabled:bg-gray-800 disabled:text-gray-500",
  secondary:
    "bg-[#16161a] text-gray-200 hover:text-white hover:bg-[#1f1f25] border border-white/10 hover:border-white/20 shadow-sm active:scale-[0.98] disabled:opacity-40",
  ghost:
    "bg-transparent text-gray-400 hover:text-white hover:bg-white/5 border border-transparent disabled:opacity-30",
  danger:
    "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 border border-rose-500/30 hover:border-rose-500/50 shadow-sm active:scale-[0.98] disabled:opacity-40",
  tab:
    "bg-transparent text-gray-400 hover:text-white hover:bg-white/5 border border-transparent rounded-lg font-medium",
  pill:
    "rounded-full bg-white/5 text-gray-300 hover:text-white hover:bg-white/10 border border-white/10 text-3xs font-mono transition-all",
};

const activeStyles: Partial<Record<ButtonVariant, string>> = {
  tab: "bg-[#FF6C37]/15 text-[#FF6C37] border border-[#FF6C37]/30 shadow-sm font-semibold",
  secondary: "bg-[#FF6C37]/15 text-[#FF6C37] border-[#FF6C37]/40 shadow-sm font-semibold",
  ghost: "bg-white/10 text-white font-medium",
  pill: "bg-[#FF6C37]/20 text-[#FF6C37] border-[#FF6C37]/40 font-bold",
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
          <span className="text-4xs font-mono text-gray-400 bg-white/5 px-1 py-0.2 rounded border border-white/10 ml-auto">
            {shortcut}
          </span>
        )}
      </button>
    );
  }
);

Button.displayName = "Button";
