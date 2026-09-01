#!/usr/bin/env node
import { createGateway } from "./gateway.js";

let gateway;
try {
  gateway = await createGateway();
  const address = await gateway.listen();
  process.stdout.write(`Frontier gateway listening on http://${address.address}:${address.port}; session token is available only through the allowed-origin bootstrap.\n`);
} catch (error) {
  process.stderr.write(`Frontier gateway failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
}

let closing = false;
async function shutdown(signal) {
  if (closing || !gateway) return;
  closing = true;
  process.stdout.write(`Frontier gateway received ${signal}; shutting down.\n`);
  try {
    await gateway.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
