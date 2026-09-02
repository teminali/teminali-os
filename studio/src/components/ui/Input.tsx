import React from "react";
import { X } from "lucide-react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
  clearable?: boolean;
  onClear?: () => void;
  variant?: "default" | "search" | "mono";
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      icon,
      clearable = false,
      onClear,
      variant = "default",
      value,
      className = "",
      ...props
    },
    ref
  ) => {
    return (
      <div className="relative flex items-center w-full">
        {icon && (
          <span className="absolute left-3 text-ink-placeholder flex items-center pointer-events-none">
            {icon}
          </span>
        )}
        <input
          ref={ref}
          value={value}
          className={`lit lit-inner w-full h-8 bg-surface rounded-lg text-xs text-ink-high placeholder:text-ink-placeholder outline-none transition-colors ${ icon ? "pl-8" : "pl-3" } ${clearable && value ? "pr-8" : "pr-3"} ${ variant === "mono" ? "font-mono" : "font-sans" } ${className}`}
          {...props}
        />
        {clearable && value && (
          <button
            type="button"
            onClick={onClear}
            className="absolute right-2.5 p-0.5 rounded text-ink-placeholder hover:text-ink-high hover:bg-surface-hover"
            title="Clear input"
          >
            <X size={12} />
          </button>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
