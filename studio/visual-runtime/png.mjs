import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 50_000_000;

export class PngDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "PngDecodeError";
  }
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const readUint32 = (bytes, offset) =>
  (((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);

const chunkType = (bytes, offset) =>
  String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

const paeth = (left, up, upperLeft) => {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
};

function unfilterScanlines(inflated, width, height, channels) {
  const rowBytes = width * channels;
  const expected = height * (rowBytes + 1);
  if (inflated.length !== expected) {
    throw new PngDecodeError(`Inflated image data has ${inflated.length} bytes; expected ${expected}.`);
  }

  const output = new Uint8Array(rowBytes * height);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    if (filter > 4) throw new PngDecodeError(`Unsupported PNG row filter ${filter}.`);
    const rowOffset = y * rowBytes;
    const previousOffset = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[inputOffset + x];
      const left = x >= channels ? output[rowOffset + x - channels] : 0;
      const up = y > 0 ? output[previousOffset + x] : 0;
      const upperLeft = y > 0 && x >= channels ? output[previousOffset + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      output[rowOffset + x] = (raw + predictor) & 0xff;
    }
    inputOffset += rowBytes;
  }
  return output;
}

function convertToRgba(samples, width, height, colorType) {
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  let source = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const target = pixel * 4;
    if (colorType === 6) {
      rgba[target] = samples[source];
      rgba[target + 1] = samples[source + 1];
      rgba[target + 2] = samples[source + 2];
      rgba[target + 3] = samples[source + 3];
      source += 4;
    } else if (colorType === 2) {
      rgba[target] = samples[source];
      rgba[target + 1] = samples[source + 1];
      rgba[target + 2] = samples[source + 2];
      rgba[target + 3] = 255;
      source += 3;
    } else if (colorType === 4) {
      rgba[target] = samples[source];
      rgba[target + 1] = samples[source];
      rgba[target + 2] = samples[source];
      rgba[target + 3] = samples[source + 1];
      source += 2;
    } else {
      rgba[target] = samples[source];
      rgba[target + 1] = samples[source];
      rgba[target + 2] = samples[source];
      rgba[target + 3] = 255;
      source += 1;
    }
  }
  return rgba;
}

export function decodePng(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new PngDecodeError("PNG input must be Uint8Array bytes.");
  if (bytes.length < PNG_SIGNATURE.length + 12) throw new PngDecodeError("PNG input is truncated.");
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) throw new PngDecodeError("PNG signature is invalid.");
  }

  let offset = PNG_SIGNATURE.length;
  let header = null;
  let sawEnd = false;
  const imageChunks = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new PngDecodeError("PNG chunk header is truncated.");
    const length = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + length;
    if (crcOffset + 4 > bytes.length) throw new PngDecodeError("PNG chunk payload is truncated.");
    const type = chunkType(bytes, typeOffset);
    const crcInput = bytes.subarray(typeOffset, crcOffset);
    const expectedCrc = readUint32(bytes, crcOffset);
    if (crc32(crcInput) !== expectedCrc) throw new PngDecodeError(`PNG ${type} chunk failed CRC validation.`);
    const data = bytes.subarray(dataOffset, crcOffset);

    if (type === "IHDR") {
      if (header || length !== 13) throw new PngDecodeError("PNG must contain one 13-byte IHDR chunk.");
      header = {
        width: readUint32(data, 0),
        height: readUint32(data, 4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      if (!header) throw new PngDecodeError("PNG IDAT appeared before IHDR.");
      imageChunks.push(data);
    } else if (type === "IEND") {
      if (length !== 0) throw new PngDecodeError("PNG IEND chunk must be empty.");
      sawEnd = true;
      offset = crcOffset + 4;
      break;
    } else if ((bytes[typeOffset] & 0x20) === 0 && !["PLTE"].includes(type)) {
      throw new PngDecodeError(`Unsupported critical PNG chunk ${type}.`);
    }
    offset = crcOffset + 4;
  }

  if (!header || !sawEnd || imageChunks.length === 0) throw new PngDecodeError("PNG is missing IHDR, IDAT, or IEND.");
  if (offset !== bytes.length) throw new PngDecodeError("PNG has trailing bytes after IEND.");
  if (header.width === 0 || header.height === 0 || header.width * header.height > MAX_PIXELS) {
    throw new PngDecodeError("PNG dimensions are empty or exceed the safe pixel limit.");
  }
  if (header.bitDepth !== 8) throw new PngDecodeError(`Unsupported PNG bit depth ${header.bitDepth}; only 8-bit images are accepted.`);
  if (![0, 2, 4, 6].includes(header.colorType)) throw new PngDecodeError(`Unsupported PNG color type ${header.colorType}.`);
  if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new PngDecodeError("Unsupported PNG compression, filter, or interlace method.");
  }

  const compressedLength = imageChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  for (const chunk of imageChunks) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.length;
  }
  let inflated;
  try {
    inflated = inflateSync(compressed);
  } catch (error) {
    throw new PngDecodeError(`PNG IDAT decompression failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
  const samples = unfilterScanlines(inflated, header.width, header.height, channels);
  return {
    width: header.width,
    height: header.height,
    rgba: convertToRgba(samples, header.width, header.height, header.colorType),
  };
}
