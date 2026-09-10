/**
 * The accent control, and the promise it makes.
 *
 * Settings > Appearance lets the operator move the accent anywhere on the hue
 * wheel. `--accent-ink` — the text that sits ON an accent fill — used to be
 * the constant #151515, and that was only ever safe because `--accent` was the
 * constant #00bf63. The moment the hue is the operator's, it is not: dark ink
 * on a blue accent at the brand's lightness measures 1.52:1, which is not text.
 *
 * So `solveAccent` chooses the ink per fill and darkens the fill where neither
 * ink clears AA. These tests exist because that is a claim about every colour
 * an operator can pick, and the only honest way to hold it is to check them
 * all. The figures quoted in `DESIGN.md` §3 are pinned here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BRAND_HUE,
  CHROME_CLUSTER_WIDTH,
  CHROME_SIDE,
  DEFAULT_APPEARANCE,
  contrast,
  hslToHex,
  normalizeAppearance,
  resolveChromeStyle,
  solveAccent,
} from "../src/services/appearance.ts";

const AA = 4.5;

test("the default accent is the brand green, exactly", () => {
  // Not "close to" — the three accent tokens in tokens.css are this hue at
  // full saturation and three lightnesses, so the default must round-trip.
  assert.equal(hslToHex(BRAND_HUE, 100, 37.5), "#00bf63"); // --accent
  assert.equal(hslToHex(BRAND_HUE, 100, 42), "#00d66f"); // --accent-hover
  assert.equal(hslToHex(BRAND_HUE, 100, 30), "#00994f"); // --accent-dim
});

test("the brand's own contrast is the 7.5:1 the token sheet claims", () => {
  const { lightness, ink } = solveAccent(BRAND_HUE, 100);
  assert.equal(lightness, 37.5, "the brand is never nudged");
  assert.equal(ink, "#151515", "and keeps the dark ink it was measured with");
  assert.equal(contrast(ink, hslToHex(BRAND_HUE, 100, lightness)).toFixed(2), "7.51");
});

test("the constant dark ink really was unreadable off-hue", () => {
  // The finding that motivated deriving the ink at all. If this ever stops
  // being true the solver has become unnecessary, not the test wrong.
  assert.ok(contrast("#151515", hslToHex(240, 100, 37.5)) < 2, "blue at the brand's lightness");
});

test("every hue and intensity an operator can pick clears AA", () => {
  let worst = { ratio: Infinity };
  for (let saturation = 0; saturation <= 100; saturation += 1) {
    for (let hue = 0; hue < 360; hue += 1) {
      const { lightness, ink } = solveAccent(hue, saturation);
      const ratio = contrast(ink, hslToHex(hue, saturation, lightness));
      if (ratio < worst.ratio) worst = { ratio, hue, saturation, lightness, ink };
    }
  }
  assert.ok(
    worst.ratio >= AA,
    `worst case hue ${worst.hue} intensity ${worst.saturation} measured ${worst.ratio?.toFixed(2)}:1`
  );
});

test("the fill is nudged only where it has to be", () => {
  // A solver that darkened everything would be safe and wrong: it would move
  // colours the operator picked for no reason. Roughly an eighth of the space
  // is the crossover band around orange and teal.
  let moved = 0;
  let total = 0;
  for (let saturation = 0; saturation <= 100; saturation += 1) {
    for (let hue = 0; hue < 360; hue += 1) {
      total += 1;
      if (solveAccent(hue, saturation).lightness !== 37.5) moved += 1;
    }
  }
  const share = (100 * moved) / total;
  assert.ok(share > 5 && share < 20, `nudged ${share.toFixed(1)}% of the hue x intensity space`);
});

test("a settings blob from an older build is filled in, not trusted", () => {
  const restored = normalizeAppearance({ accentHue: 999, uiFontSize: 99, uiFontFamily: "comic" });
  assert.equal(restored.accentHue, 360, "hue is clamped to the wheel");
  assert.equal(restored.uiFontSize, 17, "type size is clamped to the range the stepper offers");
  assert.equal(restored.uiFontFamily, "system", "an unknown face falls back rather than being set");
  assert.equal(restored.codeFontSize, DEFAULT_APPEARANCE.codeFontSize, "missing keys take the default");
});

test("an explicit chrome style overrides the host, which is the point of it", () => {
  // Three chrome styles are only testable on one machine because of this.
  assert.equal(resolveChromeStyle("windows"), "windows");
  assert.equal(resolveChromeStyle("linux"), "linux");
  assert.equal(resolveChromeStyle("macos"), "macos");
  // No `window` in the test process, so "system" falls back to the platform
  // the app is developed against.
  assert.equal(resolveChromeStyle("system"), "macos");
});

test("each chrome dialect claims the end of the bar its platform claims", () => {
  // The title bar reserves from this, not from a constant. Flip a value here
  // and the cluster renders on top of the panel tab strip.
  assert.equal(CHROME_SIDE.macos, "left");
  assert.equal(CHROME_SIDE.windows, "right");
  assert.equal(CHROME_SIDE.linux, "right");
});

test("the cluster widths are the measurements, not a guess", () => {
  // Plan §4.3. Each is the sum of what the component actually draws; if the
  // two drift the cluster overflows the width its own bar reserved for it.
  assert.equal(CHROME_CLUSTER_WIDTH.macos, 13 * 3 + 10 * 2, "three 13px discs on a 10px gap");
  assert.equal(CHROME_CLUSTER_WIDTH.windows, 46 * 3, "three flush 46px caption buttons");
  assert.equal(CHROME_CLUSTER_WIDTH.linux, 24 * 3 + 6 * 2 + 6 * 2, "24px circles, 6px gap, 6px inset");
});
