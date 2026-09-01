import { createHash } from "node:crypto";
import { decodePng, PngDecodeError } from "./png.mjs";

const VIEWPORT_FIELDS = ["width", "height", "deviceScaleFactor", "fontFingerprint", "animationState", "seed"];

export class VisualEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "VisualEvidenceError";
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new VisualEvidenceError("Image base64 is malformed.");
  }
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function imageBytes(image) {
  if (!isRecord(image)) throw new VisualEvidenceError("Evidence image is missing.");
  const hasBytes = image.bytes !== undefined;
  const hasBase64 = image.bytesBase64 !== undefined;
  if (hasBytes === hasBase64) throw new VisualEvidenceError("Supply exactly one of image.bytes or image.bytesBase64.");
  if (hasBase64) return decodeBase64(image.bytesBase64);
  if (image.bytes instanceof Uint8Array) return new Uint8Array(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  if (image.bytes instanceof ArrayBuffer) return new Uint8Array(image.bytes);
  throw new VisualEvidenceError("image.bytes must be Uint8Array or ArrayBuffer.");
}

function validateViewport(viewport) {
  if (!isRecord(viewport)) throw new VisualEvidenceError("Viewport metadata is missing.");
  if (!Number.isInteger(viewport.width) || viewport.width <= 0) throw new VisualEvidenceError("Viewport width must be a positive integer.");
  if (!Number.isInteger(viewport.height) || viewport.height <= 0) throw new VisualEvidenceError("Viewport height must be a positive integer.");
  if (!finite(viewport.deviceScaleFactor) || viewport.deviceScaleFactor <= 0) throw new VisualEvidenceError("Viewport deviceScaleFactor must be positive.");
  if (typeof viewport.fontFingerprint !== "string" || viewport.fontFingerprint.length === 0) throw new VisualEvidenceError("Viewport fontFingerprint is required.");
  if (!["disabled", "frozen"].includes(viewport.animationState)) throw new VisualEvidenceError("Viewport animationState must be disabled or frozen.");
  if (typeof viewport.seed !== "string" || viewport.seed.length === 0) throw new VisualEvidenceError("Viewport seed is required.");
}

function validateEvidence(evidence, label) {
  if (!isRecord(evidence)) throw new VisualEvidenceError(`${label} evidence is missing.`);
  if (typeof evidence.sourceId !== "string" || evidence.sourceId.length === 0) throw new VisualEvidenceError(`${label} sourceId is required.`);
  if (typeof evidence.capturedAt !== "string" || !Number.isFinite(Date.parse(evidence.capturedAt))) throw new VisualEvidenceError(`${label} capturedAt must be an ISO timestamp.`);
  validateViewport(evidence.viewport);
}

function decodeEvidenceImage(evidence) {
  const bytes = imageBytes(evidence.image);
  const image = evidence.image;
  if (!Number.isInteger(image.width) || image.width <= 0 || !Number.isInteger(image.height) || image.height <= 0) {
    throw new VisualEvidenceError("Image width and height must be positive integers.");
  }
  const expectedWidth = Math.round(evidence.viewport.width * evidence.viewport.deviceScaleFactor);
  const expectedHeight = Math.round(evidence.viewport.height * evidence.viewport.deviceScaleFactor);
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    throw new VisualEvidenceError(
      `Image dimensions ${image.width}×${image.height} do not match the controlled viewport raster ${expectedWidth}×${expectedHeight}.`,
    );
  }

  let decoded;
  if (image.mimeType === "application/x-rgba") {
    const expected = image.width * image.height * 4;
    if (bytes.length !== expected) throw new VisualEvidenceError(`Raw RGBA has ${bytes.length} bytes; expected ${expected}.`);
    decoded = { width: image.width, height: image.height, rgba: Uint8Array.from(bytes) };
  } else if (image.mimeType === "image/png") {
    try {
      decoded = decodePng(bytes);
    } catch (error) {
      if (error instanceof PngDecodeError) throw new VisualEvidenceError(error.message);
      throw error;
    }
    if (decoded.width !== image.width || decoded.height !== image.height) {
      throw new VisualEvidenceError("Declared PNG dimensions do not match its IHDR dimensions.");
    }
  } else {
    throw new VisualEvidenceError(`Unsupported image MIME type ${String(image.mimeType)}.`);
  }
  return { ...decoded, sourceSha256: sha256(bytes) };
}

export function compareViewportMetadata(reference, candidate) {
  validateViewport(reference);
  validateViewport(candidate);
  const differences = VIEWPORT_FIELDS
    .filter((field) => reference[field] !== candidate[field])
    .map((field) => ({ field, reference: reference[field], candidate: candidate[field] }));
  return { compatible: differences.length === 0, differences };
}

const srgbLinear = (byte) => {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

function rgbaToLab(r, g, b, alpha) {
  const opacity = alpha / 255;
  const compositedR = r * opacity + 255 * (1 - opacity);
  const compositedG = g * opacity + 255 * (1 - opacity);
  const compositedB = b * opacity + 255 * (1 - opacity);
  const linearR = srgbLinear(compositedR);
  const linearG = srgbLinear(compositedG);
  const linearB = srgbLinear(compositedB);
  const x = (0.4124564 * linearR + 0.3575761 * linearG + 0.1804375 * linearB) / 0.95047;
  const y = 0.2126729 * linearR + 0.7151522 * linearG + 0.072175 * linearB;
  const z = (0.0193339 * linearR + 0.119192 * linearG + 0.9503041 * linearB) / 1.08883;
  const transform = (value) => value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116;
  const fx = transform(x);
  const fy = transform(y);
  const fz = transform(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const deltaE76 = (left, right) => Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);

function comparePixels(reference, candidate, perceptualThreshold) {
  const pixelCount = reference.width * reference.height;
  let differentPixels = 0;
  let totalChannelDelta = 0;
  let maxChannelDelta = 0;
  let totalDeltaE = 0;
  let maxDeltaE = 0;
  let pixelsAbovePerceptualThreshold = 0;
  const perceptualDeltas = new Float64Array(pixelCount);

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    let differs = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(reference.rgba[offset + channel] - candidate.rgba[offset + channel]);
      if (delta !== 0) differs = true;
      totalChannelDelta += delta;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
    }
    if (differs) differentPixels += 1;
    const leftLab = rgbaToLab(...reference.rgba.subarray(offset, offset + 4));
    const rightLab = rgbaToLab(...candidate.rgba.subarray(offset, offset + 4));
    const deltaE = deltaE76(leftLab, rightLab);
    perceptualDeltas[pixel] = deltaE;
    totalDeltaE += deltaE;
    if (deltaE > maxDeltaE) maxDeltaE = deltaE;
    if (deltaE > perceptualThreshold) pixelsAbovePerceptualThreshold += 1;
  }

  const sorted = Array.from(perceptualDeltas).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    exact: {
      pixelCount,
      differentPixels,
      differentPixelRatio: round(differentPixels / pixelCount),
      meanAbsoluteChannelDelta: round(totalChannelDelta / (pixelCount * 4)),
      maxChannelDelta,
    },
    perceptual: {
      method: "CIE76 over sRGB composited on white",
      thresholdDeltaE: perceptualThreshold,
      meanDeltaE: round(totalDeltaE / pixelCount),
      p95DeltaE: round(sorted[p95Index]),
      maxDeltaE: round(maxDeltaE),
      pixelsAboveThreshold: pixelsAbovePerceptualThreshold,
      pixelsAboveThresholdRatio: round(pixelsAbovePerceptualThreshold / pixelCount),
    },
  };
}

const validRect = (rect) => isRecord(rect) && finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height) && rect.width >= 0 && rect.height >= 0;

export function compareGeometry(referenceGeometry, candidateGeometry, toleranceCssPx = 1) {
  if (referenceGeometry == null || candidateGeometry == null) {
    return { status: "unmeasured", reason: "Both reference and candidate geometry evidence are required.", metrics: null };
  }
  if (!isRecord(referenceGeometry) || !isRecord(candidateGeometry) || !finite(toleranceCssPx) || toleranceCssPx < 0) {
    return { status: "error", reason: "Geometry maps and a non-negative tolerance are required.", metrics: null };
  }
  const invalid = [
    ...Object.entries(referenceGeometry).filter(([, rect]) => !validRect(rect)).map(([id]) => `reference:${id}`),
    ...Object.entries(candidateGeometry).filter(([, rect]) => !validRect(rect)).map(([id]) => `candidate:${id}`),
  ];
  if (invalid.length > 0) return { status: "error", reason: `Invalid rectangles: ${invalid.join(", ")}.`, metrics: null };

  const referenceIds = Object.keys(referenceGeometry).sort();
  const candidateIds = Object.keys(candidateGeometry).sort();
  const missingIds = referenceIds.filter((id) => !(id in candidateGeometry));
  const extraIds = candidateIds.filter((id) => !(id in referenceGeometry));
  const matchedIds = referenceIds.filter((id) => id in candidateGeometry);
  let maxAbsoluteDeltaCssPx = 0;
  const elements = matchedIds.map((id) => {
    const reference = referenceGeometry[id];
    const candidate = candidateGeometry[id];
    const delta = {
      x: round(candidate.x - reference.x),
      y: round(candidate.y - reference.y),
      width: round(candidate.width - reference.width),
      height: round(candidate.height - reference.height),
    };
    const elementMax = Math.max(...Object.values(delta).map(Math.abs));
    if (elementMax > maxAbsoluteDeltaCssPx) maxAbsoluteDeltaCssPx = elementMax;
    return { id, reference, candidate, delta, maxAbsoluteDeltaCssPx: elementMax, withinTolerance: elementMax <= toleranceCssPx };
  });
  return {
    status: "measured",
    reason: null,
    metrics: {
      toleranceCssPx,
      referenceCount: referenceIds.length,
      candidateCount: candidateIds.length,
      matchedCount: matchedIds.length,
      missingIds,
      extraIds,
      maxAbsoluteDeltaCssPx: round(maxAbsoluteDeltaCssPx),
      allWithinTolerance: missingIds.length === 0 && extraIds.length === 0 && elements.every((item) => item.withinTolerance),
      elements,
    },
  };
}

const unmeasuredReport = (reason) => ({
  status: "unmeasured",
  reason,
  evidence: null,
  viewport: null,
  pixelMetrics: null,
  geometry: { status: "unmeasured", reason: "Image evidence was not supplied.", metrics: null },
});

export function compareVisualEvidence(referenceEvidence, candidateEvidence, options = {}) {
  if (referenceEvidence == null || candidateEvidence == null) {
    return unmeasuredReport("Both timestamped reference and candidate image evidence are required.");
  }
  try {
    validateEvidence(referenceEvidence, "Reference");
    validateEvidence(candidateEvidence, "Candidate");
    const viewport = compareViewportMetadata(referenceEvidence.viewport, candidateEvidence.viewport);
    if (!viewport.compatible) {
      return {
        status: "error",
        reason: "Viewport metadata differs; pixel comparison would not be controlled.",
        evidence: null,
        viewport,
        pixelMetrics: null,
        geometry: compareGeometry(referenceEvidence.geometry, candidateEvidence.geometry, options.geometryToleranceCssPx ?? 1),
      };
    }
    const reference = decodeEvidenceImage(referenceEvidence);
    const candidate = decodeEvidenceImage(candidateEvidence);
    if (reference.width !== candidate.width || reference.height !== candidate.height) {
      throw new VisualEvidenceError("Reference and candidate image dimensions differ.");
    }
    const perceptualThreshold = options.perceptualThresholdDeltaE ?? 2.3;
    if (!finite(perceptualThreshold) || perceptualThreshold < 0) throw new VisualEvidenceError("Perceptual threshold must be non-negative.");
    return {
      status: "measured",
      reason: null,
      evidence: {
        reference: { sourceId: referenceEvidence.sourceId, capturedAt: referenceEvidence.capturedAt, sha256: reference.sourceSha256 },
        candidate: { sourceId: candidateEvidence.sourceId, capturedAt: candidateEvidence.capturedAt, sha256: candidate.sourceSha256 },
      },
      viewport,
      pixelMetrics: comparePixels(reference, candidate, perceptualThreshold),
      geometry: compareGeometry(referenceEvidence.geometry, candidateEvidence.geometry, options.geometryToleranceCssPx ?? 1),
    };
  } catch (error) {
    return {
      status: "error",
      reason: error instanceof Error ? error.message : String(error),
      evidence: null,
      viewport: null,
      pixelMetrics: null,
      geometry: { status: "unmeasured", reason: "Image evidence validation failed.", metrics: null },
    };
  }
}
