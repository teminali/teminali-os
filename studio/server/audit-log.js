import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const SAFE_FIELDS = new Set([
  "timestamp",
  "event",
  "correlationId",
  "method",
  "route",
  "provider",
  "status",
  "durationMs",
  "requestBytes",
  "responseBytes",
  "errorCode",
  "retryable",
  "cancelled",
  /* Guardian. All non-secret scalars: a local model name, the rule that fired,
     and byte counts. Without them an auto-unload line records that something
     was evicted but not what or why, which is not an audit trail. */
  "model",
  "rule",
  "vramBytes",
  "freedBytes",
  /* Settings changes already passed these two and had them silently dropped. */
  "enabled",
  "maxApps",
]);

function sanitize(entry) {
  return Object.fromEntries(
    Object.entries(entry).filter(([key, value]) => SAFE_FIELDS.has(key) && value !== undefined),
  );
}

export class BoundedAuditLog {
  constructor(path, options = {}) {
    this.path = path;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 3;
    this.pending = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.path, "a", 0o600);
    await handle.close();
  }

  write(entry) {
    const line = `${JSON.stringify(sanitize({ timestamp: new Date().toISOString(), ...entry }))}\n`;
    this.pending = this.pending.then(async () => {
      await this.#rotateIfNeeded(Buffer.byteLength(line));
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.writeFile(line);
      } finally {
        await handle.close();
      }
    });
    return this.pending;
  }

  async flush() {
    await this.pending;
  }

  async #rotateIfNeeded(incomingBytes) {
    let currentBytes = 0;
    try {
      currentBytes = (await stat(this.path)).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (currentBytes + incomingBytes <= this.maxBytes) return;

    const oldest = `${this.path}.${this.maxFiles}`;
    await unlink(oldest).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      await rename(`${this.path}.${index}`, `${this.path}.${index + 1}`).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rename(this.path, `${this.path}.1`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
