import React from "react";

export type BadgeVariant =
  | "sky"
  | "emerald"
  | "amber"
  | "purple"
  | "rose"
  | "neutral"
  | "shortcut"
  | "model";

export type BadgeSize = "xs" | "sm" | "md";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  icon?: React.ReactNode;
  dot?: boolean;
}

const variantStyles: Record<BadgeVariant, string> = {
  sky: "bg-[#38bdf8]/10 text-[#38bdf8] border border-[#38bdf8]/25",
  emerald: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/25",
  amber: "bg-amber-500/10 text-amber-300 border border-amber-500/25",
  purple: "bg-purple-500/10 text-purple-300 border border-purple-500/25",
  rose: "bg-rose-500/10 text-rose-300 border border-rose-500/25",
  neutral: "bg-white/5 text-gray-300 border border-white/10",
  shortcut: "bg-white/5 text-gray-400 border border-white/10 font-mono text-4xs shadow-inner",
  model: "bg-[#141724] text-gray-200 border border-white/10 font-mono",
};

const dotColors: Record<BadgeVariant, string> = {
  sky: "bg-[#38bdf8]",
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  purple: "bg-purple-400",
  rose: "bg-rose-400",
  neutral: "bg-gray-400",
  shortcut: "bg-gray-500",
  model: "bg-[#38bdf8]",
};

const sizeStyles: Record<BadgeSize, string> = {
  xs: "px-1.5 py-0.2 text-4xs gap-1 rounded",
  sm: "px-2 py-0.5 text-3xs gap-1.5 rounded-md",
  md: "px-2.5 py-1 text-xs gap-1.5 rounded-lg",
};

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "neutral",
  size = "sm",
  icon,
  dot = false,
  className = "",
  ...props
}) => {
  return (
    <span
      className={`inline-flex items-center font-medium select-none font-sans ${
        variantStyles[variant]
      } ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColors[variant]}`} />}
      {icon && <span className="flex-shrink-0">{icon}</span>}
      <span>{children}</span>
    </span>
  );
};
