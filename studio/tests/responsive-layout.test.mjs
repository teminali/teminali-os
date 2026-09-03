import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssPath = new URL("../src/index.css", import.meta.url);

test("overlay panels are positioned from the workspace, not an inherited grid cell", async () => {
  const css = await readFile(cssPath, "utf8");

  assert.match(
    css,
    /\.workspace\[data-layout="balanced"\]\s*>\s*\.explorer-panel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*inset:\s*0\s+auto\s+0\s+52px;/s,
  );
  assert.match(
    css,
    /\.workspace\[data-layout="compact"\]\s*>\s*\.explorer-panel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*inset:\s*0\s+auto\s+0\s+48px;/s,
  );
  assert.match(
    css,
    /\.workspace\[data-layout="compact"\]\s*>\s*\.assistant-panel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s,
  );
});

/* ── The video editor's tier scale ──────────────────────────────────────────
   The editor answers "how much room do I have" in three languages — a TS
   tier in `hooks/useDensity.tsx`, `data-tier` selectors in
   `video-components.css`, and two column thresholds in `VideoPane.tsx` — and
   the whole point of the density hook is that they are ONE answer. These
   tests are what stops the third copy from drifting, which is what happened
   to the four ad-hoc width checks the hook replaced.
   ───────────────────────────────────────────────────────────────────────── */

const videoCssPath = new URL("../src/video/video-components.css", import.meta.url);
const densityPath = new URL("../src/video/hooks/useDensity.tsx", import.meta.url);
const panePath = new URL("../src/components/workspace/panels/VideoPane.tsx", import.meta.url);
const toolbarPath = new URL("../src/video/components/timeline/TimelineToolbar.tsx", import.meta.url);
const alignBarPath = new URL("../src/video/components/canvas/AlignmentBar.tsx", import.meta.url);
const panelStorePath = new URL("../src/store/panelStore.ts", import.meta.url);
const workspacePath = new URL("../src/components/workspace/WorkspacePanel.tsx", import.meta.url);

test("the tier scale is declared once and every tier has a stylesheet", async () => {
  const density = await readFile(densityPath, "utf8");
  const css = await readFile(videoCssPath, "utf8");

  // The breakpoints, as the hook states them.
  assert.match(density, /TIER_MIN:\s*Record<Tier,\s*number>\s*=\s*\{\s*xs:\s*0,\s*sm:\s*460,\s*md:\s*640,\s*lg:\s*900\s*\}/);

  // Every tier that gives something back has rules keyed to it. `lg` is the
  // baseline and deliberately has none — it is what the ported sheet already
  // draws, so a `[data-tier="lg"]` block would be a second copy of it.
  for (const tier of ["xs", "sm", "md"]) {
    assert.match(css, new RegExp(`\\.video-workspace\\[data-tier='${tier}'\\]`), `no rules for tier ${tier}`);
  }
});

test("the video panel's tiers are the pane's own width, never the display's", async () => {
  const css = await readFile(videoCssPath, "utf8");
  // From the layer's opening brace, so the slice never starts mid-comment.
  const responsiveLayer = css
    .slice(css.indexOf("@layer components", css.indexOf("THE RESPONSIVE LAYER")))
    // Comments explain the rule; only the rules themselves are the contract.
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // A media query here would answer about the screen while this editor lives
  // in a 452px panel on it — `lg` styling at `xs` width, every time.
  const mediaQueries = responsiveLayer.match(/@media[^{]*\{/g) ?? [];
  assert.deepEqual(
    mediaQueries.filter((q) => !q.includes("prefers-reduced-motion")),
    [],
    "the responsive layer must key off data-tier, not @media",
  );
});

test("the pane's column thresholds are derived, not re-typed", async () => {
  const pane = await readFile(panePath, "utf8");

  // Both minimums are arithmetic over the named part widths. Typing 576 or
  // 840 directly is how a resized inspector stops agreeing with the width
  // that was supposed to seat it.
  assert.match(pane, /const INSPECTOR_COLUMN_MIN_W = INSPECTOR_W \+ MONITOR_MIN_W;/);
  assert.match(pane, /const LIBRARY_COLUMN_MIN_W = LIBRARY_W \+ MONITOR_MIN_W \+ INSPECTOR_W;/);
});

test("every timeline tool that leaves the bar is still reachable in the menu", async () => {
  const toolbar = await readFile(toolbarPath, "utf8");

  // The partition must be total: `onBar` and `inMenu` are complements over
  // the same list, so no tier can drop a tool on the floor.
  assert.match(toolbar, /const onBar = tools\.filter\(\(t\) => RANK\[t\.from\] <= density\.rank\);/);
  assert.match(toolbar, /const inMenu = tools\.filter\(\(t\) => RANK\[t\.from\] > density\.rank\);/);

  // And the tightest tier must still seat the three tools an edit cannot
  // proceed without — cut, remove, and the mode that decides what they do.
  for (const id of ["split", "delete", "snap"]) {
    assert.match(
      toolbar,
      new RegExp(`id: '${id}',[^}]*from: 'xs'`),
      `${id} must keep its seat on the bar at every width`,
    );
  }
});

test("the alignment shelf keeps alignment, and hides transforms without losing them", async () => {
  const bar = await readFile(alignBarPath, "utf8");
  // The menu is declared before the JSX; the JSX is everything from the
  // component's one `return (`.
  const menu = bar.slice(bar.indexOf("const menuItems"), bar.indexOf("return ("));
  const strip = bar.slice(bar.indexOf("return ("));

  // Align and distribute are what the shelf is named for, and they only
  // mean anything side by side. They stay on the strip.
  assert.match(strip, /ALIGN_BUTTONS\.map/);
  for (const axis of ["x", "y"]) {
    assert.ok(strip.includes(`handleDistribute('${axis}')`), `distribute ${axis} must stay on the shelf`);
  }

  // The four transform actions are demoted, not removed. A fourteen-icon
  // strip floating over the picture is what this was asked to stop being,
  // and "nothing may be removed — only the click count changes" is the
  // other half of that instruction.
  for (const call of ["handleFlip('h')", "handleFlip('v')", "handleFitToFrame", "handleReset"]) {
    assert.ok(menu.includes(call), `${call} must survive in the overflow menu`);
    assert.ok(
      !strip.includes(`onClick={() => ${call}}`) && !strip.includes(`onClick={${call}}`),
      `${call} must not keep its own button on the shelf`,
    );
  }

  // One overflow control, opened the way every other one here is opened,
  // and it says how much it is holding.
  assert.match(strip, /openMenu\(e, menuItems, 'left'\)/);
  assert.match(strip, /\$\{menuItems\.length\} more layer tools/);
});

test("the media library in the editor is the shell's own panel, not a second copy", async () => {
  const pane = await readFile(panePath, "utf8");

  // Two media browsers reading one pool is two places for an import to fail
  // to appear. The sidebar tab stays where it is — it is the consent surface
  // — and the editor rail renders the same component.
  assert.match(pane, /import \{ MediaPanel \} from "\.\.\/\.\.\/sidebar\/MediaPanel";/);
  assert.equal((pane.match(/<MediaPanel \/>/g) ?? []).length, 2, "one seated column, one overlay");
});

test("the inspector can be put away at every width, through one control", async () => {
  const pane = await readFile(panePath, "utf8");

  // Seated is `wide enough` MINUS `put away`. If the column ever reads
  // `canSeatInspector` again directly, minimising it silently stops working
  // at exactly the width the feature exists for.
  assert.match(pane, /const inspectorSeated = canSeatInspector && !inspectorMinimized;/);
  assert.match(pane, /\{inspectorSeated \? \(/);

  // The overlay is the NARROW tier's answer only. Without the guard, a
  // minimised column at `lg` would summon an overlay over the space it just
  // gave back — two inspectors' worth of chrome for one inspector.
  assert.match(pane, /!canSeatInspector && inspectorOpen && \(/);

  // One button, both mechanisms. `Edit` must NOT be gated on the tier the
  // way `Media` is: gating it is how the seated inspector became permanent.
  assert.doesNotMatch(pane, /\{!canSeatInspector && \(\s*<button/);
  assert.match(pane, /if \(canSeatInspector\) setInspectorMinimized\(\(m\) => !m\);/);
  assert.match(pane, /else setInspectorOpen\(\(o\) => !o\);/);
});

test("the panel cannot be wider than the room, however it got its width", async () => {
  const store = await readFile(panelStorePath, "utf8");
  const workspace = await readFile(workspacePath, "utf8");

  // Clamping inside `setWidth` alone covers the drag and nothing else. A
  // width rehydrated from a session on a wider window, and a window dragged
  // narrower afterwards, both skip it — and the shell does not scroll, so the
  // overflow was measured at 684px of the editor simply gone off the right.
  assert.match(store, /export function clampPanelWidth\(width: number\): number \{/);
  assert.match(store, /setWidth: \(width\) => set\(\(\) => \(\{ width: clampPanelWidth\(width\) \}\)\),/);
  assert.match(workspace, /clampPanelWidth/);

  // The rendered width is the clamped one. Putting the store's `width` back
  // in the style is the regression this exists to catch.
  assert.match(workspace, /style=\{\{ width: isExpanded \? "var\(--panel-w-expanded\)" : available \}\}/);

  // ...and it is re-clamped when the room changes, by either route: the
  // window, or the inset App.tsx publishes as the sidebar moves.
  assert.match(workspace, /window\.addEventListener\("resize", measure\)/);
  assert.match(workspace, /attributeFilter: \["style"\]/);

  // The inset stops at the sidebar's edge and counts neither splitter. Those
  // two 2px gutters are exactly what a derived clamp still spilled, so the
  // shell is measured; the CSS vars are the pre-paint fallback, not the
  // answer.
  assert.match(store, /document\.querySelector\("\[data-chat-column\]"\)\?\.getBoundingClientRect\(\)/);
  assert.match(store, /panel\.left - chat\.right/);
});
