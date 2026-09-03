/**
 * The assistant tray's glyph, under plain Node.
 *
 * The menu bar item draws the product mark by rasterising the geometry of
 * `build/mark.svg` rather than loading a file, which buys a packaged build with
 * no asset to lose and costs a copy of the numbers that can drift from the
 * source. These tests pin the two ways that copy can go wrong silently: a
 * template image whose colour channels are not empty renders as a filled block
 * instead of a mark, and a mis-scaled box paints outside the 16-point square or
 * off-centre — neither of which throws, and both of which only ever show up in
 * a screenshot of somebody's menu bar.
 *
 * Electron cannot run in the test process, so `require("electron")` is answered
 * with a stand-in that keeps the buffers the real `nativeImage` would have been
 * handed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const Module = require_("node:module");
const TRAY = "../electron/assistant-tray.cjs";

/* ── Harness ──────────────────────────────────────────────────────────────── */

/** Every representation handed to nativeImage, in the order it arrived. */
function renderIcon() {
  const representations = [];
  let template = null;

  const electron = {
    Menu: { buildFromTemplate: () => ({}) },
    Tray: class {},
    app: { getName: () => "Teminali Code" },
    nativeImage: {
      createFromBuffer(buffer, { width, height, scaleFactor }) {
        representations.push({ buffer, width, height, scaleFactor });
        return {
          addRepresentation: (rep) => representations.push(rep),
          setTemplateImage: (value) => { template = value; },
        };
      },
    },
  };

  const realLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electron;
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    delete require_.cache[require_.resolve(TRAY)];
    require_(TRAY).assistantIcon();
  } finally {
    Module._load = realLoad;
  }

  return { representations, template };
}

/** Alpha as a width-by-height grid, which is the only channel that carries shape. */
function alphaGrid({ buffer, width, height }) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) row.push(buffer[(y * width + x) * 4 + 3]);
    rows.push(row);
  }
  return rows;
}

/* ── Tests ────────────────────────────────────────────────────────────────── */

test("the icon ships a 1x and a 2x representation of a 16pt square", () => {
  const { representations, template } = renderIcon();

  assert.equal(representations.length, 2, "one buffer per scale factor");
  assert.deepEqual(
    representations.map((rep) => [rep.scaleFactor, rep.width, rep.height]),
    [[1, 16, 16], [2, 32, 32]],
  );
  assert.equal(template, true, "a menu bar glyph must be a template image");
});

test("shape lives in alpha alone, so macOS can paint it for either menu bar", () => {
  for (const rep of renderIcon().representations) {
    const { buffer, width, height } = rep;
    let colour = 0;
    for (let i = 0; i < width * height * 4; i += 4) colour += buffer[i] + buffer[i + 1] + buffer[i + 2];
    assert.equal(colour, 0, `@${rep.scaleFactor}x wrote colour bytes; the mark would render as a block`);
  }
});

test("the mark is drawn, and drawn solidly", () => {
  for (const rep of renderIcon().representations) {
    const alpha = alphaGrid(rep).flat();
    assert.equal(Math.max(...alpha), 255, `@${rep.scaleFactor}x never reaches full coverage`);
    const covered = alpha.filter((value) => value > 0).length;
    // Two chevrons and a rule over a 16pt square: present, and nowhere near a
    // filled box. The band is wide because antialiasing is scale-dependent.
    assert.ok(covered > alpha.length * 0.08, `@${rep.scaleFactor}x drew almost nothing (${covered}px)`);
    assert.ok(covered < alpha.length * 0.45, `@${rep.scaleFactor}x drew a blob (${covered}px)`);
  }
});

test("the glyph is mirror-symmetric, as the mark's two chevrons are", () => {
  for (const rep of renderIcon().representations) {
    const rows = alphaGrid(rep);
    for (let y = 0; y < rows.length; y += 1) {
      for (let x = 0; x < rows[y].length; x += 1) {
        const mirrored = rows[y][rows[y].length - 1 - x];
        assert.ok(
          Math.abs(rows[y][x] - mirrored) <= 1,
          `@${rep.scaleFactor}x row ${y} is lopsided at column ${x}: ${rows[y][x]} vs ${mirrored}`,
        );
      }
    }
  }
});

test("nothing is painted into the square's margins", () => {
  for (const rep of renderIcon().representations) {
    const rows = alphaGrid(rep);
    const scale = rep.scaleFactor;
    const painted = (row) => row.some((value) => value > 0);

    // Half a point of inset each side, and a mark 324/680 as tall as it is wide
    // centred in the square: the top and bottom thirds must stay empty.
    const quiet = Math.floor(4 * scale);
    for (let y = 0; y < quiet; y += 1) {
      assert.ok(!painted(rows[y]), `@${scale}x painted into the top margin at row ${y}`);
      assert.ok(!painted(rows[rows.length - 1 - y]), `@${scale}x painted into the bottom margin at row ${y}`);
    }
    for (const row of rows) {
      assert.equal(row[0], 0, `@${scale}x painted the left edge column`);
      assert.equal(row[row.length - 1], 0, `@${scale}x painted the right edge column`);
    }
  }
});
