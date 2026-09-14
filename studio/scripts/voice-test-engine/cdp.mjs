/**
 * Teminali OS Voice Test Engine — CDP Connection & Discovery Helper
 *
 * Provides smart, wise, and portable discovery of Electron over Chrome DevTools Protocol:
 * - Dynamic port probing (9222..9226) with retry backoff.
 * - Robust target window discovery.
 * - Structured WebSocket RPC client with promise-based call() and console log capturing.
 */

import fs from "node:fs";

/**
 * Checks if a CDP port is responsive.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<Array<any> | null>}
 */
async function probeCdpPort(port, timeoutMs = 800) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Discovers an active CDP port, checking candidate ports and retrying with backoff.
 * @param {number} preferredPort
 * @param {number} maxRetries
 * @param {number} retryDelayMs
 * @returns {Promise<{ port: number, pages: Array<any> }>}
 */
export async function discoverCdp(preferredPort = 9222, maxRetries = 8, retryDelayMs = 800) {
  const candidatePorts = [preferredPort, 9222, 9223, 9224, 9225, 9226].filter(
    (v, i, a) => a.indexOf(v) === i
  );

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    for (const port of candidatePorts) {
      const pages = await probeCdpPort(port);
      if (pages && Array.isArray(pages) && pages.length > 0) {
        return { port, pages };
      }
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  throw new Error(
    `Could not connect to Electron CDP on ports [${candidatePorts.join(", ")}].\n` +
      `Ensure Teminali OS is running with remote debugging enabled:\n` +
      `  npm run start\n` +
      `  or: electron --remote-debugging-port=${preferredPort} electron/main.cjs`
  );
}

/**
 * Finds the Teminali OS studio page among CDP targets.
 * @param {Array<any>} pages
 * @returns {any}
 */
export function findTemiPage(pages) {
  // First priority: page with "Teminali" in title or URL
  let page = pages.find(
    (p) =>
      p.type === "page" &&
      ((p.title && p.title.toLowerCase().includes("teminali")) ||
        (p.url && (p.url.includes("3000") || p.url.includes("localhost"))))
  );

  // Fallback: any page type
  if (!page) {
    page = pages.find((p) => p.type === "page");
  }

  if (!page) {
    throw new Error(`Found CDP endpoint, but no active application page was located among targets.`);
  }

  return page;
}

/**
 * Connects to a CDP WebSocket debugger endpoint.
 * @param {string} webSocketDebuggerUrl
 * @returns {Promise<CdpClient>}
 */
export async function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  const consoleLogs = [];

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.method === "Runtime.consoleAPICalled") {
        const line = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        consoleLogs.push({ type: msg.params.type, line, time: Date.now() });
      }

      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch {
      // ignore parse errors
    }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP WebSocket connection timed out.")), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(null);
    };
    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });

  function call(method, params = {}) {
    const reqId = id++;
    return new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ id: reqId, method, params }));
    });
  }

  // Enable essential domains
  await call("Runtime.enable");
  await call("Page.enable");

  return {
    ws,
    call,
    consoleLogs,
    evaluate: async (expression, awaitPromise = false) => {
      const res = await call("Runtime.evaluate", {
        expression,
        awaitPromise,
        returnByValue: true,
      });
      return res?.result?.value;
    },
    takeScreenshot: async (outPath) => {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      if (shot?.data) {
        fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));
        return true;
      }
      return false;
    },
    close: () => {
      try {
        ws.close();
      } catch {
        // ignore close error
      }
    },
  };
}
