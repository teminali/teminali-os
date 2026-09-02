import React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "glass" | "interactive" | "bubble";
  padding?: "none" | "sm" | "md" | "lg";
}

const variantStyles: Record<string, string> = {
  default: "bg-surface border border-edge text-ink-prose shadow-sm",
  glass:
    "bg-frame-mid/90 backdrop-blur-md border-t border-edge-strong border-x border-edge-chrome border-b border-edge-chrome text-ink-prose shadow-xl",
  interactive:
    "bg-surface border border-edge hover:border-accent/40 hover:bg-surface-hover text-ink-prose hover:text-ink-high cursor-pointer transition-all active:scale-[0.99] shadow-sm",
  bubble: "bg-surface-active border border-edge text-ink-high shadow-md",
};

const paddingStyles: Record<string, string> = {
  none: "p-0",
  sm: "p-2.5",
  md: "p-3.5",
  lg: "p-5",
};

export const Card: React.FC<CardProps> = ({
  children,
  variant = "default",
  padding = "md",
  className = "",
  ...props
}) => {
  return (
    <div
      className={`rounded-xl select-none font-sans ${variantStyles[variant]} ${paddingStyles[padding]} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};
