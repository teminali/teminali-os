import React from "react";

export type BadgeVariant =
  | "orange"
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
  orange: "bg-accent/15 text-accent border border-accent/30",
  sky: "bg-accent/10 text-accent border border-accent/25",
  emerald: "bg-success/10 text-success border border-success/25",
  amber: "bg-warning/10 text-warning border border-warning/25",
  purple: "bg-reason/10 text-reason border border-reason/25",
  rose: "bg-danger/10 text-danger border border-danger/25",
  neutral: "bg-surface-chip text-ink-dim border border-edge",
  shortcut: "bg-surface-chip text-ink-muted border border-edge font-mono text-4xs shadow-inner",
  model: "bg-surface text-ink-prose border border-edge font-mono",
};

const dotColors: Record<BadgeVariant, string> = {
  orange: "bg-accent",
  sky: "bg-accent",
  emerald: "bg-success",
  amber: "bg-warning",
  purple: "bg-reason",
  rose: "bg-danger",
  neutral: "bg-surface-chip",
  shortcut: "bg-surface-chip",
  model: "bg-accent",
};

const sizeStyles: Record<BadgeSize, string> = {
  xs: "px-1.5 py-0.2 text-4xs gap-1 rounded",
  sm: "px-2 py-0.5 text-3xs gap-1.5 rounded-md",
  md: "px-2.5 py-1 text-xs gap-1.5 rounded-lg",
};

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "orange",
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
