import React from "react";

/**
 * A product's real mark, rather than a lucide stand-in.
 *
 * Claude Code and Codex were drawn with `Sparkles` and `Bot` — generic glyphs
 * that told you an agent was involved but not which one. On a surface where you
 * pick between them, and in a benchmark where you compare them, the actual logo
 * is the fastest thing to recognise.
 *
 * These are third-party brand marks. They are used unmodified and untinted,
 * which is both the correct thing to do with someone else's logo and the reason
 * this component takes no colour prop.
 */

export type Brand = "teminali" | "claude" | "codex";

const SOURCES: Record<Brand, { src: string; label: string }> = {
  // Served from public/, so these are absolute paths at runtime.
  teminali: { src: "/teminali-logo-128.png", label: "Teminali" },
  claude: { src: "/brand/claude-code-128.png", label: "Claude Code" },
  codex: { src: "/brand/codex-128.png", label: "Codex" },
};

export const BrandGlyph: React.FC<{
  brand: Brand;
  size?: number;
  className?: string;
}> = ({ brand, size = 14, className = "" }) => {
  const { src, label } = SOURCES[brand];
  return (
    <img
      src={src}
      alt={label}
      width={size}
      height={size}
      // The marks are square with their own breathing room baked in, so they sit
      // on the same optical baseline as the 14-16px lucide icons beside them.
      className={`flex-shrink-0 object-contain select-none ${className}`}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
};
