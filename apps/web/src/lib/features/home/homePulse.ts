import type { NetworkFile } from '#lib/v1/schemas/network.ts';

/**
 * What the live network snapshot reports right now: two counts and no share. A live percentage
 * would share the word "on time" with the record, so the home shows none (UX plan §2.3); live
 * delay counts wait for the three-band method.
 */
export interface LivePulse {
	/** Vehicles reporting a position in the live feed; null when the file's count is not whole. */
	readonly reporting: number | null;
	/** Trips scheduled now with no vehicle reporting; null when the file's count is not whole. */
	readonly silent: number | null;
}

function wholeCount(value: number | null | undefined): number | null {
	return value != null && Number.isSafeInteger(value) && value >= 0 ? value + 0 : null;
}

export function selectLivePulse(net: NetworkFile | null): LivePulse | null {
	if (!net) return null;
	return { reporting: wholeCount(net.vehicles_in_service), silent: wholeCount(net.non_responding) };
}
