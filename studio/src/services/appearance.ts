/**
 * Appearance — the settings that change how the whole shell looks, and the one
 * function that makes them true.
 *
 * This is deliberately not a React module. `applyAppearance` writes CSS custom
 * properties and root classes onto `document.documentElement`, so it works in
 * any renderer we own — the main window *and* the recorder window, which has
 * no access to the studio store. `resolveChromeStyle` is likewise callable
 * outside React, which is what the title-bar reflow needs (see
 * `docs/SETTINGS_AND_CHROME_PLAN.md` §4.4).
 *
 * TDS governance still applies: this file may compute a colour, but only into
 * a token that `styles/tokens.css` already declares. It must never introduce a
 * colour a component then reads directly.
 */

/** Where the window controls live, before the host is consulted. */
export type ChromeStyle = "system" | "macos" | "windows" | "linux";

/** The concrete style, after the host has been consulted. Never "system". */
export type ResolvedChromeStyle = "macos" | "windows" | "linux";

/** How much of a tool call the chat shows once a turn has settled. */
export type ToolCallDensity = "compact" | "detailed";

export interface AppearanceSettings {
  /** Window control cluster. "system" resolves from `window.teminali.platform`. */
  chromeStyle: ChromeStyle;
  /** "compact" collapses a settled tool strip; "detailed" leaves it open. */
  toolCallDensity: ToolCallDensity;
  /** Wrap long lines in code blocks instead of scrolling them sideways. */
  codeWordWrap: boolean;
  /** Tint added/removed diff lines, rather than colouring only the text. */
  themedDiffBackgrounds: boolean;
  /** Accent hue in degrees. 151 is the brand green. */
  accentHue: number;
  /** Accent saturation, 0–100. 100 is the brand green. */
  accentIntensity: number;
  /** Drop every backdrop blur in the interface. An accessibility control. */
  reduceTransparency: boolean;
  /** Base UI type size in px. 13 is `--text-sm`, the measured chrome size. */
  uiFontSize: number;
  /** Code type size in px. 12 is the measured snippet size. */
  codeFontSize: number;
  /** Key into `UI_FONTS`. */
  uiFontFamily: string;
  /** Key into `CODE_FONTS`. */
  codeFontFamily: string;
}

/**
 * The brand green in HSL. Every accent token in `tokens.css` is this hue at
 * full saturation and a different lightness, which is why hue+saturation is
 * all the accent control has to move: hue 151 / intensity 100 reproduces
 * #00bf63, #00d66f and #00994f exactly, so the default is not an approximation
 * of the brand — it *is* the brand.
 */
export const BRAND_HUE = 151;

/**
 * Text on an accent fill, and the canvas ink it may fall back to. Both are
 * measured tokens (`--accent-ink`, `--ink-bright`); the accent control picks
 * between them rather than assuming the dark one, because it no longer can.
 */
const ACCENT_INK_DARK = "#151515";
const ACCENT_INK_BRIGHT = "#f0f0f0";

/** WCAG AA for body text. The floor the accent control is not allowed to cross. */
const MIN_INK_CONTRAST = 4.5;

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  chromeStyle: "system",
  toolCallDensity: "compact",
  codeWordWrap: false,
  themedDiffBackgrounds: true,
  accentHue: BRAND_HUE,
  accentIntensity: 100,
  reduceTransparency: false,
  uiFontSize: 13,
  codeFontSize: 12,
  uiFontFamily: "system",
  codeFontFamily: "system",
};

/**
 * The faces we offer, each as a full stack that ends in a generic family. A
 * name in this list is not a claim the face is installed — it is a claim that
 * asking for it is safe, because the stack degrades to the platform face.
 */
export const UI_FONTS: Record<string, { label: string; stack: string }> = {
  system: {
    label: "System",
    stack: `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, "Helvetica Neue", sans-serif`,
  },
  inter: { label: "Inter", stack: `"Inter", -apple-system, BlinkMacSystemFont, sans-serif` },
  helvetica: { label: "Helvetica Neue", stack: `"Helvetica Neue", Helvetica, Arial, sans-serif` },
  segoe: { label: "Segoe UI", stack: `"Segoe UI", -apple-system, Roboto, sans-serif` },
  roboto: { label: "Roboto", stack: `Roboto, -apple-system, "Segoe UI", sans-serif` },
};

export const CODE_FONTS: Record<string, { label: string; stack: string }> = {
  system: {
    label: "System",
    stack: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`,
  },
  jetbrains: { label: "JetBrains Mono", stack: `"JetBrains Mono", ui-monospace, Menlo, monospace` },
  sfmono: { label: "SF Mono", stack: `"SF Mono", ui-monospace, Menlo, monospace` },
  fira: { label: "Fira Code", stack: `"Fira Code", ui-monospace, Menlo, monospace` },
  consolas: { label: "Consolas", stack: `Consolas, ui-monospace, "Courier New", monospace` },
};

/**
 * The measured type ramp from `tokens.css`, in px. The UI font-size control
 * scales the whole ramp by `uiFontSize / 13` rather than setting one token,
 * because a settings screen that grows the body text and leaves the badges
 * behind has broken the scale, not resized it.
 */
const TYPE_RAMP: Array<[token: string, px: number]> = [
  ["--text-3xs", 10],
  ["--text-2xs", 11],
  ["--text-xs", 12],
  ["--text-sm", 13],
  ["--text-md", 14],
  ["--text-lg", 16],
];

const RAMP_BASE = 13;

/**
 * The accent ramp, as lightness offsets from `--accent`'s own stop. Measured
 * off the brand hexes: #00bf63 at 37.5%, #00d66f at 42%, #00994f at 30%. They
 * move together, so when the accent's lightness is nudged for contrast the
 * ramp keeps its shape rather than collapsing onto one value.
 */
const ACCENT_BASE_LIGHTNESS = 37.5;
const ACCENT_STOPS: Array<[token: string, offset: number]> = [
  ["--accent", 0],
  ["--accent-hover", 4.5],
  ["--accent-dim", -7.5],
  ["--lit-accent-top", 0],
  ["--lit-accent-mid", 0],
];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** HSL to `#rrggbb`. The tokens stay hex so nothing downstream sees a format change. */
export const hslToHex = (h: number, s: number, l: number): string => {
  const sat = s / 100;
  const lum = l / 100;
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = lum - c / 2;
  const byte = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
};

/** Relative luminance, WCAG 2.1. */
const luminance = (hex: string): number => {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

/** WCAG contrast ratio between two opaque hexes. Exported for `tests/appearance.test.mjs`. */
export const contrast = (a: string, b: string): number => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/**
 * Pick the accent's lightness and its ink together.
 *
 * `--accent-ink` used to be the constant #151515, which was only ever safe
 * because the accent was the constant #00bf63. Once the hue is the operator's,
 * it is not: dark ink on a blue accent at the brand's lightness measures
 * 1.52:1. So the ink is chosen per fill, and where neither ink clears
 * {@link MIN_INK_CONTRAST} — a narrow band around orange and teal, 12.6% of
 * the hue x intensity space — the fill is walked darker until one does.
 *
 * The brand is untouched by all of this: hue 151 at intensity 100 keeps
 * lightness 37.5%, fill #00bf63 and dark ink, measuring 7.51:1.
 */
export const solveAccent = (hue: number, saturation: number): { lightness: number; ink: string } => {
  for (let lightness = ACCENT_BASE_LIGHTNESS; lightness >= 18; lightness -= 0.5) {
    const fill = hslToHex(hue, saturation, lightness);
    const dark = contrast(ACCENT_INK_DARK, fill);
    const bright = contrast(ACCENT_INK_BRIGHT, fill);
    const ink = dark >= bright ? ACCENT_INK_DARK : ACCENT_INK_BRIGHT;
    if (Math.max(dark, bright) >= MIN_INK_CONTRAST) return { lightness, ink };
  }
  // Unreachable for any hue: by 18% lightness the bright ink clears easily.
  return { lightness: 18, ink: ACCENT_INK_BRIGHT };
};

/** HSL to `rgba(r, g, b, a)` — `--focus-ring` needs alpha and is declared that way. */
const hslToRgba = (h: number, s: number, l: number, alpha: number): string => {
  const hex = hslToHex(h, s, l);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** The host platform, or null outside the desktop shell. */
export const hostPlatform = (): string | null =>
  (typeof window !== "undefined" && window.teminali?.platform) || null;

/**
 * Turn the setting into the style that actually renders. "system" asks the
 * host; anything else is the operator overriding it, which is the whole point
 * of the control — and the only way three chrome styles are testable on one
 * machine.
 */
export const resolveChromeStyle = (style: ChromeStyle = "system"): ResolvedChromeStyle => {
  if (style !== "system") return style;
  const platform = hostPlatform();
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  // darwin, and the browser, where the app is developed against macOS chrome.
  return "macos";
};

/**
 * Which edge each dialect puts its cluster on. A bar reserves from this rather
 * than from a constant, because on Windows and Linux the cluster lands where
 * the panel tab strip already lives.
 */
export const CHROME_SIDE: Record<ResolvedChromeStyle, "left" | "right"> = {
  macos: "left",
  windows: "right",
  linux: "right",
};

/**
 * What each cluster costs in width, so a bar can reserve it without measuring
 * the DOM. macOS: three 13px discs on a 10px gap. Windows: three flush 46px
 * caption buttons. Linux: three 24px circles on a 6px gap inside a 6px inset.
 *
 * These live here rather than in the component for the same reason
 * `resolveChromeStyle` does: the recorder window is a second renderer with no
 * store and no React tree of ours, and a layout constant that only exists
 * inside a component is a constant that window cannot honour.
 */
export const CHROME_CLUSTER_WIDTH: Record<ResolvedChromeStyle, number> = {
  macos: 59,
  windows: 138,
  linux: 96,
};

/** Fill in anything a persisted older shape is missing, and clamp the numbers. */
export const normalizeAppearance = (partial?: Partial<AppearanceSettings>): AppearanceSettings => {
  const merged = { ...DEFAULT_APPEARANCE, ...(partial ?? {}) };
  return {
    ...merged,
    accentHue: clamp(Math.round(merged.accentHue), 0, 360),
    accentIntensity: clamp(Math.round(merged.accentIntensity), 0, 100),
    uiFontSize: clamp(merged.uiFontSize, 11, 17),
    codeFontSize: clamp(merged.codeFontSize, 10, 18),
    uiFontFamily: merged.uiFontFamily in UI_FONTS ? merged.uiFontFamily : "system",
    codeFontFamily: merged.codeFontFamily in CODE_FONTS ? merged.codeFontFamily : "system",
  };
};

/**
 * Write the settings onto the document. Idempotent, cheap, and safe to call on
 * every store change — it sets properties, it does not diff them.
 */
export const applyAppearance = (partial?: Partial<AppearanceSettings>): AppearanceSettings => {
  const settings = normalizeAppearance(partial);
  if (typeof document === "undefined") return settings;
  const root = document.documentElement;

  const { accentHue: hue, accentIntensity: sat } = settings;
  const { lightness, ink } = solveAccent(hue, sat);
  for (const [token, offset] of ACCENT_STOPS) {
    root.style.setProperty(token, hslToHex(hue, sat, clamp(lightness + offset, 0, 100)));
  }
  root.style.setProperty("--accent-ink", ink);
  root.style.setProperty("--focus-ring", hslToRgba(hue, sat, lightness, 0.14));

  const ratio = settings.uiFontSize / RAMP_BASE;
  for (const [token, px] of TYPE_RAMP) {
    root.style.setProperty(token, `${Math.round(px * ratio * 10) / 10}px`);
  }
  root.style.setProperty("--code-font-size", `${settings.codeFontSize}px`);

  root.style.setProperty("--font-sans", UI_FONTS[settings.uiFontFamily].stack);
  root.style.setProperty("--font-mono", CODE_FONTS[settings.codeFontFamily].stack);

  root.classList.toggle("app-wrap-code", settings.codeWordWrap);
  root.classList.toggle("app-reduce-transparency", settings.reduceTransparency);
  root.classList.toggle("app-plain-diff", !settings.themedDiffBackgrounds);
  root.dataset.chrome = resolveChromeStyle(settings.chromeStyle);

  return settings;
};
