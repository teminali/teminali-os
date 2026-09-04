/* ═══════════════════════════════════════════════════════════════════
   THE ONE MEASUREMENT.

   The editor used to ask its own question about size in four places —
   `VideoPane` compared its width to a two-column minimum, `ClipBlock`
   called anything under 72px compact, `TrackHeader` used 46px, and the
   toolbars asked nothing at all and simply overflowed. Four thresholds
   measured against four different boxes cannot agree, and the visible
   result was a 452px panel drawing a toolbar built for 1200px: "Delete"
   clipped to "Du", the zoom readout sitting on top of the slider.

   So the pane measures ITSELF once, resolves a tier, and publishes it.
   Every component below asks the same question of the same number.

   TIERS ARE THE PANEL'S WIDTH, NOT THE WINDOW'S. This is a workspace
   panel that opens at 452px beside a chat column and expands to 736px,
   and can be dragged wider still — so a media query would be answering
   about the display while the editor lives in a sliver of it. That is
   why this is a ResizeObserver and not a breakpoint.

     xs  < 460   one column, controls collapse to icons, inspector is a
                 sheet. This is CapCut's phone shape, and it is what the
                 panel opens at.
     sm  460-639 one column still, but labels return to the primary
                 actions and the transport keeps its own row.
     md  640-899 two columns: monitor + inspector. Toolbar icon-only.
     lg  >= 900  everything, with labels. The desktop editor.

   The vertical tier is separate and matters just as much: a 300px-tall
   pane has no room for a 291px timeline no matter how wide it is.
   ═══════════════════════════════════════════════════════════════════ */

import React, { createContext, useContext, useMemo } from 'react';

export type Tier = 'xs' | 'sm' | 'md' | 'lg';
export type VTier = 'short' | 'mid' | 'tall';

export interface Density {
  /** Measured pane width in px. 0 before the first observation. */
  width: number;
  /** Measured pane height in px. 0 before the first observation. */
  height: number;
  tier: Tier;
  vTier: VTier;
  /** xs or sm — one column, no room for an inspector beside the monitor. */
  isCompact: boolean;
  /** xs only — the phone shape: icons only, sheets instead of columns. */
  isTight: boolean;
  /** lg only — the tier that can afford a text label on a tool button. */
  hasLabels: boolean;
  /** Rank, for `tier >= 'md'` style comparisons without a lookup table. */
  rank: number;
}

export const TIER_MIN: Record<Tier, number> = { xs: 0, sm: 460, md: 640, lg: 900 };
const V_TIER_MIN: Record<VTier, number> = { short: 0, mid: 460, tall: 680 };
const RANK: Record<Tier, number> = { xs: 0, sm: 1, md: 2, lg: 3 };

export function resolveTier(width: number): Tier {
  // Unmeasured reads as the panel's own default seat, which is xs. Guessing
  // wide here is what would flash a desktop toolbar on every tab switch.
  if (width <= 0) return 'xs';
  if (width >= TIER_MIN.lg) return 'lg';
  if (width >= TIER_MIN.md) return 'md';
  if (width >= TIER_MIN.sm) return 'sm';
  return 'xs';
}

export function resolveVTier(height: number): VTier {
  if (height <= 0) return 'short';
  if (height >= V_TIER_MIN.tall) return 'tall';
  if (height >= V_TIER_MIN.mid) return 'mid';
  return 'short';
}

export function densityFor(width: number, height: number): Density {
  const tier = resolveTier(width);
  return {
    width,
    height,
    tier,
    vTier: resolveVTier(height),
    isCompact: tier === 'xs' || tier === 'sm',
    isTight: tier === 'xs',
    hasLabels: tier === 'lg',
    rank: RANK[tier],
  };
}

/* The default is the tightest tier, deliberately: a component rendered
   outside the provider (a test, a storybook, a future host) gets the
   layout that fits anywhere rather than the one that overflows. */
const DensityContext = createContext<Density>(densityFor(0, 0));

export const DensityProvider: React.FC<{
  width: number;
  height: number;
  children: React.ReactNode;
}> = ({ width, height, children }) => {
  const value = useMemo(() => densityFor(width, height), [width, height]);
  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>;
};

export function useDensity(): Density {
  return useContext(DensityContext);
}
