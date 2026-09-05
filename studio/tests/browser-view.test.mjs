import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedUrl, isBounds, scaleBounds } from "../electron/browserView.cjs";
import { boundsEqual, measureBrowserViewBounds } from "../src/services/browserView.ts";
import { normaliseAddress } from "../src/utils/address.ts";

/**
 * The browser panel's page is a `WebContentsView` — its own web contents, above
 * the document rather than inside it. Two things about that are worth pinning:
 * what it is allowed to load, and where it is told to be. The first is a
 * security boundary the renderer must not be the only guard of; the second is
 * arithmetic that decides whether the page covers the app.
 */

test("only http and https reach the view", () => {
  assert.equal(isAllowedUrl("http://localhost:5173"), true);
  assert.equal(isAllowedUrl("https://example.com/a?b=c#d"), true);
  for (const hostile of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "blob:http://x/y",
    "vbscript:msgbox",
    "teminali-media://abc/clip.mp4",
    "chrome://settings",
    "about:blank",
    "",
  ]) {
    assert.equal(isAllowedUrl(hostile), false, hostile);
  }
  assert.equal(isAllowedUrl(null), false);
  assert.equal(isAllowedUrl(undefined), false);
  assert.equal(isAllowedUrl({ toString: () => "http://x" }), false);
});

test("the renderer's own refusals agree with main's", () => {
  // Both sides guard; a scheme one admits and the other refuses is a panel
  // that either opens onto nothing or opens onto something it should not.
  for (const hostile of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "blob:http://x/y"]) {
    const { url } = normaliseAddress(hostile);
    assert.equal(url, null, hostile);
  }
  const { url } = normaliseAddress("5173");
  assert.equal(url, "http://localhost:5173");
  assert.equal(isAllowedUrl(url), true);
});

test("bounds are scaled by the window's zoom factor", () => {
  assert.deepEqual(scaleBounds({ x: 100, y: 50, width: 800, height: 600 }, 1), {
    x: 100,
    y: 50,
    width: 800,
    height: 600,
  });
  assert.deepEqual(scaleBounds({ x: 100, y: 50, width: 800, height: 600 }, 1.5), {
    x: 150,
    y: 75,
    width: 1200,
    height: 900,
  });
  // A view is placed in device-independent pixels and the renderer measures in
  // CSS pixels; under zoom those differ, and an unscaled rectangle would leave
  // the page sitting somewhere the panel is not.
  assert.deepEqual(scaleBounds({ x: 10.4, y: 20.6, width: 100.5, height: 50.4 }, 1), {
    x: 10,
    y: 21,
    width: 101,
    height: 50,
  });
  // A missing or nonsensical factor must not collapse the view.
  for (const factor of [undefined, 0, -1, NaN, Infinity]) {
    assert.deepEqual(scaleBounds({ x: 1, y: 2, width: 3, height: 4 }, factor), { x: 1, y: 2, width: 3, height: 4 });
  }
  // Never negative: a view with a negative size is a view Electron refuses.
  assert.deepEqual(scaleBounds({ x: 0, y: 0, width: -5, height: -5 }, 1), { x: 0, y: 0, width: 0, height: 0 });
});

test("a malformed rectangle is ignored rather than applied", () => {
  assert.equal(isBounds({ x: 0, y: 0, width: 10, height: 10 }), true);
  for (const bad of [
    null,
    undefined,
    "0,0,10,10",
    { x: 0, y: 0, width: 10 },
    { x: 0, y: 0, width: "10", height: 10 },
    { x: NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: Infinity, height: 10 },
  ]) {
    assert.equal(isBounds(bad), false, JSON.stringify(bad));
  }
});

test("the viewport is measured clamped to the window", () => {
  const window = { innerWidth: 1440, innerHeight: 900 };
  const element = (rect) => ({ getBoundingClientRect: () => rect });
  const measure = (rect) => {
    const saved = globalThis.window;
    globalThis.window = window;
    try {
      return measureBrowserViewBounds(element(rect));
    } finally {
      globalThis.window = saved;
    }
  };

  assert.deepEqual(measure({ left: 988, top: 44, right: 1440, bottom: 900 }), {
    x: 988,
    y: 44,
    width: 452,
    height: 856,
  });
  // Past the right edge: the view does not clip to the page, so a rectangle
  // that runs off the window would paint over whatever is beside it.
  assert.deepEqual(measure({ left: 1200, top: 44, right: 1800, bottom: 1200 }), {
    x: 1200,
    y: 44,
    width: 240,
    height: 856,
  });
  // Scrolled or animated fully out of view: zero size is the hide signal.
  assert.deepEqual(measure({ left: 1500, top: 44, right: 1900, bottom: 900 }), {
    x: 1440,
    y: 44,
    width: 0,
    height: 856,
  });
  assert.deepEqual(measure({ left: -400, top: -200, right: -10, bottom: -10 }), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  assert.deepEqual(measureBrowserViewBounds(null), { x: 0, y: 0, width: 0, height: 0 });
});

test("unchanged bounds compare equal so a resize drag does not flood the bridge", () => {
  const bounds = { x: 10, y: 20, width: 30, height: 40 };
  assert.equal(boundsEqual(bounds, { ...bounds }), true);
  assert.equal(boundsEqual(null, bounds), false);
  assert.equal(boundsEqual(bounds, { ...bounds, width: 31 }), false);
  assert.equal(boundsEqual(bounds, { ...bounds, x: 11 }), false);
});
