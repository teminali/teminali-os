#!/usr/bin/env node
/**
 * Start the voice sidecar. Loopback only: the gateway refuses a non-loopback
 * voice URL, and this end refuses to offer one, because recorded audio must
 * not leave the machine because somebody mistyped a hostname.
 */
import { createVoiceServer, warmUp } from "./server.js";

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
