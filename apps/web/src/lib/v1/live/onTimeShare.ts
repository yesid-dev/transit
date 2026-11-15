import { MIN_N_RATE } from '#lib/v1/stats.ts';
import type { NetworkFile } from '#lib/v1/schemas/network.ts';

/**
 * The live on-time share, or why it is held back.
 * - `share`: enough buses in service carry a delay reading to headline the percentage.
 * - `thin`: some do, but too few; the percentage would describe a handful of buses, not the network.
 * - `absent`: no bus is in service, or the feed reports no share at all.
 */
export type LiveOnTimeShare =
	| {
			readonly kind: 'share';
			readonly pct: number;
			readonly readings: number;
			readonly inService: number;
	  }
	| { readonly kind: 'thin'; readonly readings: number; readonly inService: number }
	| { readonly kind: 'absent' };

/**
 * Headline the share only when at least `MIN_N_RATE` buses have a delay reading and they are at
 * least half of the buses in service.
 */
export function liveOnTimeShare(
	net: Pick<NetworkFile, 'vehicles_in_service' | 'on_time_pct' | 'status_dist'>,
): LiveOnTimeShare {
	const inService = net.vehicles_in_service;
	if (net.on_time_pct == null || !(inService > 0)) return { kind: 'absent' };
	const readings = Math.max(0, inService - net.status_dist.unknown);
	if (readings < MIN_N_RATE || readings * 2 < inService)
		return { kind: 'thin', readings, inService };
	return { kind: 'share', pct: net.on_time_pct, readings, inService };
}
