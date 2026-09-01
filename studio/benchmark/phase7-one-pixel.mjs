import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareVisualEvidence } from "../visual-runtime/compare.mjs";

const width = 64;
const height = 64;
const referencePixels = new Uint8Array(width * height * 4).fill(255);
const candidatePixels = new Uint8Array(referencePixels);
const changedPixelIndex = 31 * width + 32;
candidatePixels.set([0, 0, 0, 255], changedPixelIndex * 4);
const capturedAt = new Date().toISOString();
const viewport = {
  width,
  height,
  deviceScaleFactor: 1,
  fontFingerprint: "synthetic-no-fonts",
  animationState: "frozen",
  seed: "phase7-one-pixel-v1",
};
const evidence = (sourceId, bytes) => ({
  sourceId,
  capturedAt,
  viewport,
  image: { mimeType: "application/x-rgba", width, height, bytes },
  geometry: { canvas: { x: 0, y: 0, width, height } },
});
const comparison = compareVisualEvidence(
  evidence("synthetic-reference", referencePixels),
  evidence("synthetic-candidate", candidatePixels),
);
const detected = comparison.status === "measured"
  && comparison.pixelMetrics.exact.differentPixels === 1
  && comparison.pixelMetrics.perceptual.pixelsAboveThreshold === 1;
if (!detected) throw new Error("The comparator did not detect the known one-pixel perturbation.");

const result = {
  phase: 7,
  passed: true,
  scope: "synthetic-one-pixel-fixture",
  browserCapture: "unmeasured",
  changedPixel: { x: 32, y: 31 },
  comparison,
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex !== -1) {
  const outputPath = process.argv[outputIndex + 1];
  if (!outputPath) throw new Error("--output requires a file path.");
  await writeFile(resolve(outputPath), serialized, { flag: "wx", mode: 0o400 });
}
process.stdout.write(serialized);
