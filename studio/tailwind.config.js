/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "#0d0f12",
        surface: "#14171d",
        surfaceHover: "#1b1f27",
        surfaceSunken: "#090b0e",
        border: "#232833",
        borderHighlight: "#363d4e",
        brand: {
          DEFAULT: "#38bdf8",
          glow: "#0ea5e9",
          subtle: "rgba(56, 189, 248, 0.12)",
        },
        accent: {
          purple: "#a855f7",
          green: "#22c55e",
          orange: "#f97316",
          gold: "#eab308",
        },
        textMain: "#f8fafc",
        textMuted: "#94a3b8",
        textFaint: "#64748b",
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "Menlo", "monospace"],
      },
      boxShadow: {
        glow: "0 0 25px -5px rgba(56, 189, 248, 0.25)",
        card: "0 10px 30px -10px rgba(0, 0, 0, 0.5)",
      },
    },
  },
  plugins: [],
};
