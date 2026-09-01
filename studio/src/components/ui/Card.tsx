import React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "glass" | "interactive" | "bubble";
  padding?: "none" | "sm" | "md" | "lg";
}

const variantStyles: Record<string, string> = {
  default: "bg-[#141724] border border-white/10 text-gray-200 shadow-sm",
  glass:
    "bg-[#0e1017]/90 backdrop-blur-md border-t border-white/15 border-x border-white/5 border-b border-white/5 text-gray-200 shadow-xl",
  interactive:
    "bg-[#141724] border border-white/10 hover:border-[#38bdf8]/40 hover:bg-[#1a1e30] text-gray-200 hover:text-white cursor-pointer transition-all active:scale-[0.99] shadow-sm",
  bubble: "bg-[#1a1d28] border border-white/10 text-gray-100 shadow-md",
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
