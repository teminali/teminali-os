# Deterministic visual comparison runtime

This directory provides Phase 7 comparison primitives. It does not capture a browser, invent a screenshot, or claim visual parity.

`compareVisualEvidence(reference, candidate)` accepts two supplied evidence records containing:

- a source identifier and ISO capture timestamp;
- exact viewport width, height, device scale factor, font fingerprint, animation state, and fixture seed;
- either 8-bit PNG bytes or raw RGBA bytes with declared dimensions;
- optional measured element rectangles keyed by stable identifier.

The result is `unmeasured` when either image is absent, `error` when evidence is malformed or viewport controls differ, and `measured` only after both byte streams decode successfully. PNG input is CRC-checked and limited to deterministic, non-interlaced 8-bit grayscale, grayscale-alpha, RGB, or RGBA images. Raw RGBA length must equal `width × height × 4`.

Measured output includes exact differing-pixel count and ratio, mean/max channel delta, CIE76 color difference after alpha compositing on white, and element-level signed geometry deltas. These are measurements, not a product superiority score.

Run the focused tests with:

```sh
node --test visual-runtime/tests/visual-runtime.test.mjs
```

Browser capture, font installation, viewport setup, and screenshot provenance remain responsibilities of an external runner. Phase 7 is not complete until that runner supplies real reference and candidate evidence across the agreed fixtures.
