export class ImageByteProofError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ImageByteProofError";
    this.code = code;
  }
}

function asBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new ImageByteProofError(
    "IMAGE_BYTES_REQUIRED",
    "Image transport requires ArrayBuffer or typed-array bytes; filenames and text labels are rejected.",
  );
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" && /^(?:avif|avis)$/.test(ascii(bytes, 8, 4))) return "image/avif";
  throw new ImageByteProofError("UNKNOWN_IMAGE_FORMAT", "Bytes do not contain a supported image signature.");
}

async function digest(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new ImageByteProofError("CRYPTO_UNAVAILABLE", "SHA-256 is unavailable in this runtime.");
  }
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function decodeBase64(value) {
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new ImageByteProofError("INVALID_BASE64", "Transported image payload is not valid base64.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Hashes and encodes actual image bytes; labels and paths are never accepted. */
export async function createImageByteTransport(input, declaredMimeType) {
  const bytes = asBytes(input);
  if (bytes.byteLength === 0) throw new ImageByteProofError("EMPTY_IMAGE", "Image byte payload is empty.");
  const detectedMimeType = sniffMime(bytes);
  if (declaredMimeType && declaredMimeType !== detectedMimeType) {
    throw new ImageByteProofError(
      "MIME_MISMATCH",
      `Declared MIME '${declaredMimeType}' does not match byte signature '${detectedMimeType}'.`,
    );
  }
  return {
    mediaType: detectedMimeType,
    byteLength: bytes.byteLength,
    sha256: await digest(bytes),
    encoding: "base64",
    data: encodeBase64(bytes),
  };
}

/** Re-hashes the transported base64 bytes before a model or vision handoff. */
export async function verifyImageByteTransport(payload) {
  if (!payload || typeof payload !== "object" || payload.encoding !== "base64" || typeof payload.data !== "string") {
    throw new ImageByteProofError("INVALID_TRANSPORT", "Image transport payload is malformed.");
  }
  const bytes = decodeBase64(payload.data);
  const detectedMimeType = sniffMime(bytes);
  const sha256 = await digest(bytes);
  if (bytes.byteLength !== payload.byteLength || sha256 !== payload.sha256 || detectedMimeType !== payload.mediaType) {
    throw new ImageByteProofError("IMAGE_PROOF_MISMATCH", "Transported image bytes do not match their recorded proof.");
  }
  return { bytes, mediaType: detectedMimeType, byteLength: bytes.byteLength, sha256 };
}
