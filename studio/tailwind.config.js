/**
 * Teminali Design System — Tailwind binding.
 *
 * Every value here points at a CSS variable declared in src/styles/tokens.css.
 * That indirection is the point: the token sheet stays the single source of
 * truth, and a theme change never requires touching a component.
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ground: "var(--ground)",

        frame: {
          top: "var(--frame-top)",
          mid: "var(--frame-mid)",
          bot: "var(--frame-bot)",
        },

        // The sidebar and the right panel. Flat in Cursor, so the three stops
        // in each triplet are equal — but they stay addressable as utilities so
        // no component has to reach for an inline style to paint a region.
        rail: {
          top: "var(--rail-top)",
          mid: "var(--rail-mid)",
          bot: "var(--rail-bot)",
        },

        panelbg: {
          top: "var(--panel-top)",
          mid: "var(--panel-mid)",
          bot: "var(--panel-bot)",
        },

        surface: {
          sunken: "var(--surface-sunken)",
          DEFAULT: "var(--surface)",
          raised: "var(--surface-raised)",
          popover: "var(--surface-popover)",
          chip: "var(--surface-chip)",
          control: "var(--surface-control)",
          hover: "var(--surface-hover)",
          active: "var(--surface-active)",
          tab: "var(--surface-tab-active)",
          skeleton: "var(--surface-skeleton)",
          skeletonDim: "var(--surface-skeleton-dim)",
        },

        edge: {
          chrome: "var(--border-chrome)",
          subtle: "var(--border-subtle)",
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
          popover: "var(--border-popover)",
        },

        ink: {
          bright: "var(--text-bright)",
          strong: "var(--text-strong)",
          high: "var(--text-high)",
          DEFAULT: "var(--text)",
          body: "var(--text-body)",
          prose: "var(--text-prose)",
          code: "var(--text-code)",
          dim: "var(--text-dim)",
          muted: "var(--text-muted)",
          soft: "var(--text-soft)",
          faint: "var(--text-faint)",
          placeholder: "var(--text-placeholder)",
          ghost: "var(--text-ghost)",
          disabled: "var(--text-disabled)",
        },

        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          dim: "var(--accent-dim)",
          // Text on an accent FILL. The accent is a light green, so anything
          // sitting on it is dark; `text-ink-high` on `bg-accent` is 2.1:1.
          ink: "var(--accent-ink)",
          code: "var(--accent-code)",
          codeBg: "var(--accent-code-bg)",
          codeBorder: "var(--accent-code-border)",
        },

        chart: { DEFAULT: "var(--chart)", track: "var(--chart-track)" },
        success: "var(--success)",
        info: "var(--info)",
        // The one chromatic element in the window. Its fill is light, so it
        // carries dark text — hence `ink`, which no other colour group needs.
        action: { DEFAULT: "var(--action)", hover: "var(--action-hover)", ink: "var(--action-ink)" },
        warning: "var(--warning)",
        danger: "var(--danger)",
        reason: "var(--reason)",

        syn: {
          keyword: "var(--syn-keyword)",
          type: "var(--syn-type)",
          string: "var(--syn-string)",
          func: "var(--syn-func)",
          attr: "var(--syn-attr)",
          tag: "var(--syn-tag)",
          comment: "var(--syn-comment)",
          plain: "var(--syn-plain)",
        },
      },

      fontFamily: {
        sans: "var(--font-sans)",
        mono: "var(--font-mono)",
      },

      fontSize: {
        "3xs": ["var(--text-3xs)", { lineHeight: "1.4" }],
        "2xs": ["var(--text-2xs)", { lineHeight: "1.45" }],
        xs: ["var(--text-xs)", { lineHeight: "1.5" }],
        sm: ["var(--text-sm)", { lineHeight: "1.55" }],
        md: ["var(--text-md)", { lineHeight: "1.5" }],
        lg: ["var(--text-lg)", { lineHeight: "1.45" }],
      },

      borderRadius: {
        xs: "var(--r-xs)",
        sm: "var(--r-sm)",
        DEFAULT: "var(--r-md)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
        xl: "var(--r-xl)",
        "2xl": "var(--r-2xl)",
        full: "var(--r-full)",
      },

      spacing: {
        titlebar: "var(--titlebar-h)",
        rail: "var(--rail-w)",
        panel: "var(--panel-w)",
        row: "var(--row-h)",
        rowLg: "var(--row-h-lg)",
        control: "var(--control-h)",
      },

      maxWidth: {
        composer: "var(--composer-max)",
        composerEmpty: "var(--composer-max-empty)",
      },

      boxShadow: {
        popover: "var(--shadow-popover)",
        modal: "var(--shadow-modal)",
        rail: "var(--inset-rail)",
        panel: "var(--inset-panel)",
      },

      transitionTimingFunction: {
        ds: "var(--ease)",
      },

      transitionDuration: {
        fast: "var(--dur-fast)",
        ds: "var(--dur)",
        slow: "var(--dur-slow)",
      },

      keyframes: {
        // The three motions the canvas defines, verbatim.
        sqIn: {
          from: { opacity: "0", transform: "translateY(-6px) scale(.985)" },
          to: { opacity: "1", transform: "none" },
        },
        sqReveal: {
          from: { opacity: "0", maxHeight: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", maxHeight: "1600px", transform: "none" },
        },
        sqFloat: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "none" },
        },
        caret: { "0%,49%": { opacity: "1" }, "50%,100%": { opacity: "0" } },
        pulseDot: {
          "0%,100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: ".55", transform: "scale(.82)" },
        },
        // Voice capture: the mic ring breathes while listening.
        listening: {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(78,201,122,.45)" },
          "50%": { boxShadow: "0 0 0 5px rgba(78,201,122,0)" },
        },
        // The assistant's target ring arriving on a control. One settle, not a
        // loop: a ring that keeps moving competes with the thing it points at.
        overlayTarget: {
          from: { opacity: "0", transform: "scale(1.06)" },
          to: { opacity: "1", transform: "none" },
        },
      },

      animation: {
        in: "sqIn var(--dur) var(--ease) both",
        reveal: "sqReveal var(--dur-slow) var(--ease) both",
        float: "sqFloat var(--dur-slow) var(--ease) both",
        caret: "caret 1.05s steps(1) infinite",
        pulseDot: "pulseDot 1.6s var(--ease) infinite",
        listening: "listening 1.4s var(--ease) infinite",
        overlayTarget: "overlayTarget var(--dur-slow) var(--ease) both",
      },
    },
  },
  plugins: [],
};
