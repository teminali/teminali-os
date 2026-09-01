import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { compareGeometry, compareVisualEvidence, compareViewportMetadata } from "../compare.mjs";
import { crc32, decodePng, PngDecodeError } from "../png.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const uint32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
};

const pngChunk = (type, data) => {
  const typeBytes = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBytes, data]);
  return Buffer.concat([uint32(data.length), crcInput, uint32(crc32(crcInput))]);
};

const encodeRgbaPng = (width, height, rgba) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    scanlines[rowOffset] = 0;
    scanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowOffset + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

const viewport = (overrides = {}) => ({
  width: 2,
  height: 2,
  deviceScaleFactor: 1,
  fontFingerprint: "inter-regular-sha256:abc123",
  animationState: "frozen",
  seed: "fixture-seed-001",
  ...overrides,
});

const rgbaEvidence = (sourceId, bytes, overrides = {}) => ({
  sourceId,
  capturedAt: "2026-08-31T12:00:00.000Z",
  viewport: viewport(),
  image: {
    mimeType: "application/x-rgba",
    width: 2,
    height: 2,
    bytes,
  },
  geometry: {
    topbar: { x: 0, y: 0, width: 2, height: 1 },
    canvas: { x: 0, y: 1, width: 2, height: 1 },
  },
  ...overrides,
});

const fourPixels = () => Uint8Array.from([
  255, 0, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255,
  255, 255, 255, 255,
]);

test("absent image evidence is reported as unmeasured", () => {
  const result = compareVisualEvidence(null, null);
  assert.equal(result.status, "unmeasured");
  assert.equal(result.pixelMetrics, null);
  assert.match(result.reason, /Both timestamped/);
});

test("fixed viewport metadata compares every controlled field", () => {
  const identical = compareViewportMetadata(viewport(), viewport());
  assert.equal(identical.compatible, true);
  assert.deepEqual(identical.differences, []);

  const changed = compareViewportMetadata(viewport(), viewport({ deviceScaleFactor: 2, seed: "different" }));
  assert.equal(changed.compatible, false);
  assert.deepEqual(changed.differences.map((item) => item.field), ["deviceScaleFactor", "seed"]);
});

test("identical raw RGBA evidence has zero exact and perceptual difference", () => {
  const pixels = fourPixels();
  const result = compareVisualEvidence(rgbaEvidence("reference", pixels), rgbaEvidence("candidate", pixels));
  assert.equal(result.status, "measured");
  assert.equal(result.pixelMetrics.exact.differentPixels, 0);
  assert.equal(result.pixelMetrics.exact.meanAbsoluteChannelDelta, 0);
  assert.equal(result.pixelMetrics.perceptual.meanDeltaE, 0);
  assert.equal(result.pixelMetrics.perceptual.pixelsAboveThreshold, 0);
  assert.equal(result.geometry.metrics.allWithinTolerance, true);
});

test("a one-pixel perturbation is detected exactly and perceptually", () => {
  const referencePixels = fourPixels();
  const candidatePixels = Uint8Array.from(referencePixels);
  candidatePixels[0] = 0;
  candidatePixels[1] = 0;
  candidatePixels[2] = 0;
  const result = compareVisualEvidence(
    rgbaEvidence("reference", referencePixels),
    rgbaEvidence("candidate", candidatePixels),
  );
  assert.equal(result.status, "measured");
  assert.equal(result.pixelMetrics.exact.pixelCount, 4);
  assert.equal(result.pixelMetrics.exact.differentPixels, 1);
  assert.equal(result.pixelMetrics.exact.differentPixelRatio, 0.25);
  assert.equal(result.pixelMetrics.exact.maxChannelDelta, 255);
  assert.equal(result.pixelMetrics.perceptual.pixelsAboveThreshold, 1);
  assert.ok(result.pixelMetrics.perceptual.maxDeltaE > 2.3);
});

test("PNG and raw RGBA decode to the same deterministic pixels", () => {
  const pixels = fourPixels();
  const png = encodeRgbaPng(2, 2, pixels);
  const pngEvidence = {
    ...rgbaEvidence("png", pixels),
    image: { mimeType: "image/png", width: 2, height: 2, bytes: png },
  };
  const result = compareVisualEvidence(rgbaEvidence("raw", pixels), pngEvidence);
  assert.equal(result.status, "measured");
  assert.equal(result.pixelMetrics.exact.differentPixels, 0);
  assert.deepEqual(Array.from(decodePng(png).rgba), Array.from(pixels));
});

test("PNG CRC corruption is rejected instead of being measured", () => {
  const png = encodeRgbaPng(2, 2, fourPixels());
  const corrupted = Buffer.from(png);
  corrupted[29] ^= 0xff;
  assert.throws(() => decodePng(corrupted), PngDecodeError);
  const result = compareVisualEvidence(
    rgbaEvidence("raw", fourPixels()),
    { ...rgbaEvidence("png", fourPixels()), image: { mimeType: "image/png", width: 2, height: 2, bytes: corrupted } },
  );
  assert.equal(result.status, "error");
  assert.match(result.reason, /CRC/);
});

test("viewport mismatch blocks an uncontrolled pixel comparison", () => {
  const pixels = fourPixels();
  const candidate = rgbaEvidence("candidate", pixels, { viewport: viewport({ width: 3 }) });
  const result = compareVisualEvidence(rgbaEvidence("reference", pixels), candidate);
  assert.equal(result.status, "error");
  assert.equal(result.pixelMetrics, null);
  assert.deepEqual(result.viewport.differences.map((item) => item.field), ["width"]);
});

test("declared image dimensions must match viewport scale", () => {
  const pixels = fourPixels();
  const scaledViewport = viewport({ deviceScaleFactor: 2 });
  const reference = rgbaEvidence("reference", pixels, { viewport: scaledViewport });
  const candidate = rgbaEvidence("candidate", pixels, { viewport: scaledViewport });
  const result = compareVisualEvidence(reference, candidate);
  assert.equal(result.status, "error");
  assert.equal(result.pixelMetrics, null);
  assert.match(result.reason, /viewport raster/);
});

test("geometry reports signed deltas, missing nodes, and one-pixel tolerance", () => {
  const reference = {
    topbar: { x: 0, y: 0, width: 100, height: 50 },
    editor: { x: 20, y: 50, width: 80, height: 100 },
  };
  const candidate = {
    topbar: { x: 0, y: 0, width: 101, height: 50 },
    extra: { x: 0, y: 0, width: 1, height: 1 },
  };
  const result = compareGeometry(reference, candidate, 1);
  assert.equal(result.status, "measured");
  assert.deepEqual(result.metrics.missingIds, ["editor"]);
  assert.deepEqual(result.metrics.extraIds, ["extra"]);
  assert.equal(result.metrics.elements[0].delta.width, 1);
  assert.equal(result.metrics.elements[0].withinTolerance, true);
  assert.equal(result.metrics.allWithinTolerance, false);
});

test("missing timestamp is rejected and never converted to a score", () => {
  const pixels = fourPixels();
  const invalid = rgbaEvidence("candidate", pixels);
  delete invalid.capturedAt;
  const result = compareVisualEvidence(rgbaEvidence("reference", pixels), invalid);
  assert.equal(result.status, "error");
  assert.equal(result.pixelMetrics, null);
  assert.match(result.reason, /capturedAt/);
});
