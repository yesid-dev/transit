import type { GoodToBadLevel } from '../goodToBadScale';

// Keep the habits' four existing value bins and use colours from the shared five-step scale.
export const HEATMAP_COLOUR_LEVELS = [0, 2, 3, 4] as const satisfies readonly GoodToBadLevel[];
export const HEATMAP_TIER_COUNT = HEATMAP_COLOUR_LEVELS.length;

export const HEATMAP_WORST_TIER = HEATMAP_TIER_COUNT - 1;

export function heatmapTier(
	value: number | null,
	domain: readonly [number, number],
): number | null {
	if (value == null || Number.isNaN(value)) return null;
	const [lo, hi] = domain;
	const span = hi - lo;
	const frac = span > 0 ? (value - lo) / span : 0;
	const clamped = Math.min(1, Math.max(0, frac));
	return Math.min(HEATMAP_TIER_COUNT - 1, Math.floor(clamped * HEATMAP_TIER_COUNT));
}

export function heatmapTierClass(tier: number | null): string {
	return tier == null ? 'dv-hm-nodata' : `dv-hm-tier-${tier}`;
}
