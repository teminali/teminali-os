import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    watch: {
      ignored: [
        "**/benchmark-results/**",
        "**/outputs/**",
        "**/.git/**",
        "**/dist/**",
        "**/node_modules/**",
        "**/*.jsonl",
        "**/*.log",
      ],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4310",
        changeOrigin: true,
        headers: {
          origin: "http://127.0.0.1:3000",
        },
      },
    },
  },
});
