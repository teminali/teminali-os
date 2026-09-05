#!/usr/bin/env node
/**
 * Start the voice sidecar. Loopback only: the gateway refuses a non-loopback
 * voice URL, and this end refuses to offer one, because recorded audio must
 * not leave the machine because somebody mistyped a hostname.
 */
import { env as transformersEnv } from "@huggingface/transformers";
import { createVoiceServer, warmUp } from "./server.js";

// Where the model weights are cached. transformers.js defaults to a `.cache`
// directory inside its own package — inside the application bundle when this
// runs packaged, where a write would break the bundle's signature and an
// update would throw the download away. electron/main.cjs passes a directory
// under userData; left unset, a development sidecar caches where it always
// has. kokoro-js loads through the same module, so one setting covers all
// three models. Set before warmUp(), which is the first thing to look.
if (process.env.TEMINALI_VOICE_CACHE) transformersEnv.cacheDir = process.env.TEMINALI_VOICE_CACHE;

const PORT = Number(process.env.TEMINALI_VOICE_PORT || 8321);
const HOST = "127.0.0.1";

const server = createVoiceServer();

server.listen(PORT, HOST, () => {
  console.error(`[voice] sidecar listening on http://${HOST}:${PORT}`);
  console.error("[voice] loading models; capabilities appear in /status as they warm");
  void warmUp();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
