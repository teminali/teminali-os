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
          <span className="absolute left-3 text-gray-500 flex items-center pointer-events-none">
            {icon}
          </span>
        )}
        <input
          ref={ref}
          value={value}
          className={`w-full h-8 bg-[#16161a] border border-white/10 focus:border-[#38bdf8]/50 rounded-lg text-xs text-white placeholder:text-gray-500 outline-none transition-colors ${
            icon ? "pl-8" : "pl-3"
          } ${clearable && value ? "pr-8" : "pr-3"} ${
            variant === "mono" ? "font-mono" : "font-sans"
          } ${className}`}
          {...props}
        />
        {clearable && value && (
          <button
            type="button"
            onClick={onClear}
            className="absolute right-2.5 p-0.5 rounded text-gray-500 hover:text-white hover:bg-white/10"
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
