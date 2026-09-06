/**
 * Teminali Design System — Tailwind binding.
 *
 * Every value here points at a CSS variable declared in src/styles/tokens.css.
 * That indirection is the point: the token sheet stays the single source of
 * truth, and a theme change never requires touching a component.
 */

/* ═══════════════════════════════════════════════════════════════════
   VIDEO PANEL FAMILIES (added for the ported Teminali Cut editor)

   Everything below is ADDITIVE. Not one existing entry above/below is
   repointed — the shell's own families keep their values, and the
   ported slice gets the names it already uses at ~2,000 call sites in
   the Cut so those files stay a clean diff against that repo.

   These are LITERALS, not `var(--x)`, and that is deliberate: the
   slice writes alpha modifiers on them (`bg-spectrum-accent/15`,
   `border-line/60`), and Tailwind cannot compute an alpha channel
   through a CSS variable that holds a hex. The values are copied from
   `teminaliCut/tailwind.config.js`; where the two systems already
   agree (ground, surface, border, accent, the role colours) they are
   character-for-character the same as this file's own tokens.
   ═══════════════════════════════════════════════════════════════════ */
const V_GROUND = "#151515";
const V_VOID = "#0f0f0f";
const V_SUNKEN = "#131313";
const V_CHROME = "#181818";
const V_SURFACE = "#212121";
const V_RAISED = "#262626";
const V_CONTROL = "#313131";
const V_HOVER = "#242424";
const V_ACTIVE = "#252525";

const V_LINE_SOFT = "#232323";
const V_LINE = "#262626";
const V_LINE_STRONG = "#313131";
const V_LINE_CHROME = "#282828";
const V_LINE_POPOVER = "#3a3a3a";

const V_INK_BRIGHT = "#f0f0f0";
const V_INK = "#ededed";
const V_INK_MUTED = "#b6b6bd";
const V_INK_DIM = "#9f9f9f";
const V_INK_FAINT = "#989898";
const V_INK_PLACEHOLDER = "#6b6b6b";
const V_INK_DISABLED = "#5a5a5a";

/* The brand green, held as a literal because this family is the ported
   Cut's palette rather than the host's var-bound one. It must track
   `--accent` in `styles/tokens.css`; if that moves, move this. */
const V_ACCENT = "#00bf63";

/* Role colours. Each clears every OTHER role on hue — a lane hue is
   DATA (it answers "what kind of track is this" at a glance), which is
   the one place the design system permits colour in the chrome.

   They used to clear the accent too, because the accent was achromatic.
   The accent is now the brand green and V_GREEN is the audio lane, so
   that no longer holds on hue alone: the two separate on saturation
   (#00bf63 against a softer #65c466) and on shape (a full-strength
   spine against a wash). It is the weakest joint in this palette. */
const V_BLUE = "#86aee4";
const V_GREEN = "#65c466";
const V_TEAL = "#4ec9b0";
const V_AMBER = "#f2ca44";
const V_RED = "#ec6765";
const V_PURPLE = "#a48fd8";
const V_PINK = "#e08ab0";

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
          code: "var(--border-code)",
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

        // ── Ported video editor: the Cut's own naming family ───────
        // Repointed here, never renamed. See the constants block at the
        // top of this file for why these are literals.
        line: {
          DEFAULT: V_LINE,
          soft: V_LINE_SOFT,
          strong: V_LINE_STRONG,
          chrome: V_LINE_CHROME,
          bright: V_LINE_POPOVER,
        },

        spectrum: {
          bg: V_GROUND,
          void: V_VOID,
          sunken: V_SUNKEN,
          panelHeader: V_CHROME,
          panel: V_CHROME,
          card: V_SURFACE,
          cardHover: V_RAISED,
          hover: V_HOVER,
          active: V_ACTIVE,
          control: V_CONTROL,

          border: V_LINE,
          borderSubtle: V_LINE_SOFT,
          borderStrong: V_LINE_STRONG,

          textBright: V_INK_BRIGHT,
          text: V_INK,
          textMuted: V_INK_MUTED,
          textDim: V_INK_DIM,
          textDimCool: V_INK_DIM,
          textFaintCool: "#8a8a8a",
          textFaint: V_INK_FAINT,
          textPlaceholder: V_INK_PLACEHOLDER,
          textDisabled: V_INK_DISABLED,

          accent: V_ACCENT,
          accentHover: "#00d66f",
          // Lifted from the near-white's 0.10 / 0.28: green carries less
          // luminance, so the old alphas left these invisible. Matched by
          // measurement — see the accent block in `video/video-tokens.css`.
          accentSoft: "rgba(0,191,99,0.16)",
          accentLine: "rgba(0,191,99,0.45)",
          onAccent: V_GROUND,

          action: V_BLUE,
          actionHover: "#9dc0ea",
          actionInk: V_GROUND,

          blue: V_BLUE,
          green: V_GREEN,
          teal: V_TEAL,
          amber: V_AMBER,
          red: V_RED,
          purple: V_PURPLE,
          pink: V_PINK,
        },

        // Track lane identity. Bright enough to read as a 2px spine on
        // dark chrome; a clip BODY never wears these at full strength.
        lane: {
          video: V_BLUE,
          overlay: V_PURPLE,
          text: V_PINK,
          audio: V_GREEN,
          effect: V_TEAL,
        },

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

        // Ported video editor. Same six-step ramp as the canonical
        // names beside it (10/11/12/13/14/16) with the Cut's own
        // fixed line-heights, which its dense control rows depend on.
        micro: ["var(--text-3xs)", { lineHeight: "14px" }],
        "ui-xs": ["var(--text-2xs)", { lineHeight: "16px" }],
        "ui-sm": ["var(--text-xs)", { lineHeight: "18px" }],
        ui: ["var(--text-xs)", { lineHeight: "18px" }],
        "ui-lg": ["var(--text-sm)", { lineHeight: "20px" }],
        "ui-xl": ["var(--text-md)", { lineHeight: "21px", letterSpacing: "-0.006em" }],
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

        // Ported video editor. `--r-2xs` is the one step this ramp
        // lacked; it is declared in src/video/video-tokens.css, so
        // rounded-squircle-2xs is inert outside .video-workspace.
        "2xs": "var(--r-2xs)",
        "squircle-2xs": "var(--r-2xs)",
        "squircle-xs": "var(--r-xs)",
        "squircle-sm": "var(--r-sm)",
        "squircle-md": "var(--r-md)",
        "squircle-lg": "var(--r-lg)",
        "squircle-xl": "var(--r-xl)",
      },

      spacing: {
        titlebar: "var(--titlebar-h)",
        rail: "var(--rail-w)",
        panel: "var(--panel-w)",
        row: "var(--row-h)",
        rowLg: "var(--row-h-lg)",
        control: "var(--control-h)",

        // Ported video editor. `panel`, `control`, `row`, `rowLg` and
        // `titlebar` are NOT re-added: this file already binds all
        // five, to different quantities (`panel` is a 452px PANEL
        // WIDTH here, `control` a 26px control HEIGHT). The five call
        // sites in the slice that wanted the Cut's meaning were moved
        // to the numeric scale instead — see src/video/README.md.
        hair: "var(--sp-1)",      // 4  — icon to label
        tight: "var(--sp-2)",     // 6  — between controls in a cluster
        section: "var(--sp-5)",   // 16 — section padding
        group: "var(--sp-6)",     // 20 — between sections
        page: "var(--sp-7)",      // 24 — a page's outer margin
        bar: "var(--h-bar)",
        disc: "var(--h-disc)",
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

        // Ported video editor. Flat by design: `clip`, `raised` and
        // `stage` resolve to none rather than being deleted, because
        // ~30 ported call sites name them. Selection and focus stay,
        // because they are STATE — a brightened hairline, not a glow.
        clip: "none",
        raised: "none",
        stage: "none",
        pop: "var(--lift-float)",
        clipSelected: "0 0 0 1.5px #e8e8e8",
        focus: "var(--focus-ring)",
      },

      transitionTimingFunction: {
        ds: "var(--ease)",
        snap: "var(--ease)",   // ported video editor — same curve
      },

      transitionDuration: {
        fast: "var(--dur-fast)",
        ds: "var(--dur)",
        slow: "var(--dur-slow)",
        base: "var(--dur)",    // ported video editor — the Cut's --t-base
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
        // The voice orb at rest. A face that never moves at all reads as a
        // logo; a slow breath is the smallest thing that reads as alive.
        orbBreathe: {
          "0%,100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.022)" },
        },
        // The same breath while it is being spoken to: shallower and quicker,
        // which is what attention looks like on a person.
        orbAttend: {
          "0%,100%": { transform: "scale(1.012)" },
          "50%": { transform: "scale(1.028)" },
        },
        // One thin arc orbiting the face while it thinks. Not a spinner: it is
        // behind the face, and it stops the moment there is an answer.
        orbThink: {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        // The assistant's target ring arriving on a control. One settle, not a
        // loop: a ring that keeps moving competes with the thing it points at.
        overlayTarget: {
          from: { opacity: "0", transform: "scale(1.06)" },
          to: { opacity: "1", transform: "none" },
        },
        // Ported video editor. `fade-in` and `scale-in` are @apply-ed
        // by the ported component sheet (src/video/video-components.css).
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.985)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
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
        orbBreathe: "orbBreathe 4.2s ease-in-out infinite",
        orbAttend: "orbAttend 1.9s ease-in-out infinite",
        orbThink: "orbThink 2.4s linear infinite",
        overlayTarget: "overlayTarget var(--dur-slow) var(--ease) both",
        "fade-in": "fade-in var(--dur-fast) var(--ease)",
        "scale-in": "scale-in var(--dur) var(--ease)",
        "slide-up": "slide-up var(--dur-slow) var(--ease)",
      },
    },
  },
  plugins: [],
};
