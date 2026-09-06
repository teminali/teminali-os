import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The dev server proxies `/api` to the gateway. The port follows
 * `FRONTIER_GATEWAY_PORT`, the same variable `server/config.js` reads, so a
 * development gateway can sit beside a packaged app that already holds 4310
 * (`FRONTIER_GATEWAY_PORT=4319 npm start`) instead of failing on EADDRINUSE.
 */
const GATEWAY_PORT = Number(process.env.FRONTIER_GATEWAY_PORT) || 4310;

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
        // electron-builder writes tens of thousands of files here, and every
        // one of them was a full page reload in the window someone was
        // watching — the dev server reloading the app out from under a
        // packaging run it has nothing to do with.
        "**/release/**",
        "**/.git/**",
        "**/dist/**",
        "**/node_modules/**",
        "**/*.jsonl",
        "**/*.log",
      ],
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${GATEWAY_PORT}`,
        changeOrigin: true,
        headers: {
          origin: "http://127.0.0.1:3000",
        },
      },
    },
  },
});
