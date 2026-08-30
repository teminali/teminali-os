import { pathToFileURL } from "node:url";

import { createGateway } from "./http-gateway.js";
import { loadRuntimeConfig } from "./runtime-config.js";

export async function startGateway({
  env = process.env,
  createGatewayImpl = createGateway,
  stdout = process.stdout,
} = {}) {
  const runtime = loadRuntimeConfig(env);
  const gateway = createGatewayImpl(runtime.getGatewayOptions());
  const url = await gateway.listen(runtime.listen);
  const summary = runtime.safeSummary;
  stdout.write(
    `gateway ready ${url} model=${summary.logicalModel} mode=${summary.mode} lanes=${summary.lanes.length}\n`,
  );
  return Object.freeze({ gateway, url, summary });
}

async function main() {
  const running = await startGateway();
  const shutdown = async () => {
    await running.gateway.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`gateway failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
