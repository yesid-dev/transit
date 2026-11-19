import type { HotspotEntry, HotspotGrain, Hotspots } from '#lib/v1/schemas/index.ts';
import { isoUtc } from '#lib/v1/schemas/types.ts';
import { worstNCap, DEFAULT_WORST_N } from '#lib/reliability/ladderCap.ts';
import { RANKED_CAP, TRAY_CAP } from './selectors/hotspotRanking';

/**
 * The record the page lays out, invisibly, while the real one loads: every region at its fullest
 * published shape, so the real record takes the room it reserved and nothing below it moves.
 * Each period ranks one line and one stop more than the first page shows (the "show all" button
 * appears). Below the reading floor, each kind lists the publisher's whole tray cap, because one
 * kind alone can fill it and the page lists every published row of the chosen kind. Names are
 * filler shaped like long real ones (capitals "M", letters "n", digits "0"), all as long as the
 * 65-character line name the home's rankings reserve (#1095), so nothing in the page's HTML
 * reads as data. Its dates
 * fall in September (the longest month name in both languages) of a year no record covers, and
 * the page prints them as filler.
 * Every figure obeys the ranking's checks.
 */
const NAMES = {
	route: 'Mnnnnnnn nnnnnn-nnnnn / Mnnnnnn Mnnnn-Mnnnnnnn <> Mnnn nnnnnnnnnn',
	stop: 'Mnnnnnn Mnnnn-MMMM / Mnnnnn-Mnnnnnnnn Mnn (nnnn nnnn) Mnnnnnnnnnn',
} as const;
const RANKED = Math.min(worstNCap(DEFAULT_WORST_N) + 1, RANKED_CAP);

function ranked(type: 'route' | 'stop', rank: number): HotspotEntry {
	return {
		rank,
		type,
		id: `00000-${rank}`,
		name: NAMES[type],
		// 1,234,567 of 9,999,999 readings: 12.3 %; the bound rises with the position.
		observation_count: 9_999_999,
		severe_count: 1_234_567,
		severe_pct: 12.3,
		wilson_lo: 87.6,
		wilson_hi: 87.8,
	};
}

function belowFloor(type: 'route' | 'stop', index: number): HotspotEntry {
	return { type, id: `00001-${index}`, name: NAMES[type], observation_count: 29 };
}

function grain(name: 'week' | 'month', from: string): HotspotGrain {
	const kinds = ['route', 'stop'] as const;
	return {
		grain: name,
		date: from,
		window_end: '2000-09-30',
		entries: kinds.flatMap((type) =>
			Array.from({ length: RANKED }, (_, index) => ranked(type, index + 1)),
		),
		tray: kinds.flatMap((type) =>
			Array.from({ length: TRAY_CAP }, (_, index) => belowFloor(type, index + 1)),
		),
		total_ranked_routes: 99_999,
		total_ranked_stops: 99_999,
		tray_total: kinds.length * TRAY_CAP,
	};
}

export const hotspotGauge: Hotspots = {
	generated_utc: isoUtc().parse('1999-09-30T00:00:00Z'),
	methodology_version: 'reliability-2',
	by_grain: [grain('week', '2000-09-24'), grain('month', '2000-09-01')],
};
