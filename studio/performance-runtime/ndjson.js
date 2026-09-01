import { BenchmarkError } from "./errors.js";

export async function consumeNdjson(stream, options = {}) {
  if (!stream || typeof stream.getReader !== "function") throw new BenchmarkError("MISSING_STREAM", "The provider response did not contain a readable stream.");
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let totalBytes = 0;
  let lineNumber = 0;
  let objectCount = 0;

  const parseLine = (line) => {
    if (line.trim().length === 0) return;
    lineNumber += 1;
    if (Buffer.byteLength(line) > maxLineBytes) throw new BenchmarkError("NDJSON_LINE_TOO_LARGE", `NDJSON line ${lineNumber} exceeded the configured limit.`);
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new BenchmarkError("MALFORMED_NDJSON", `Provider stream contained malformed JSON on line ${lineNumber}.`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new BenchmarkError("INVALID_NDJSON_OBJECT", `Provider stream line ${lineNumber} was not a JSON object.`);
    objectCount += 1;
    options.onObject?.(value, objectCount);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("benchmark stream limit reached");
      throw new BenchmarkError("STREAM_TOO_LARGE", "Provider stream exceeded the configured byte limit.");
    }
    buffered += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      parseLine(line);
    }
    if (Buffer.byteLength(buffered) > maxLineBytes) throw new BenchmarkError("NDJSON_LINE_TOO_LARGE", "An unterminated NDJSON line exceeded the configured limit.");
  }
  buffered += decoder.decode();
  if (buffered.length > 0) parseLine(buffered.replace(/\r$/, ""));
  return { bytes: totalBytes, objectCount };
}
