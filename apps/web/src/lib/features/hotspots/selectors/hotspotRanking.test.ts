import { describe, expect, it } from 'vitest';
import type { HotspotEntry, HotspotGrain } from '#lib/v1/schemas/index.ts';
import { formatDayRange, readHotspotRanking } from './hotspotRanking';

/** A ranked row as the publisher writes it: severe_pct = round(100 * severe / readings, 1). */
function ranked(kind: 'route' | 'stop', rank: number, readings: number, severe: number) {
	return {
		rank,
		type: kind,
		id: `${kind}-${rank}`,
		name: `${kind} ${rank}`,
		observation_count: readings,
		severe_count: severe,
		severe_pct: Math.round((1000 * severe) / readings) / 10,
		// The publisher orders by the lower bound of the on-time share, ascending.
		wilson_lo: 10 + rank,
		wilson_hi: 30 + rank,
	} satisfies HotspotEntry;
}

/** Seeded week: `routes` ranked lines (5 more eligible than published), two stops, a tray. */
type Grain = HotspotGrain & { entries: HotspotEntry[] };

function week(routes = 12, overrides: Partial<HotspotGrain> = {}): Grain {
	return {
		grain: 'week',
		date: '2026-11-04',
		window_end: '2026-11-10',
		entries: [
			...Array.from({ length: routes }, (_, i) => ranked('route', i + 1, 40 + i, 30 - i)),
			ranked('stop', 1, 64, 60),
			ranked('stop', 2, 47, 40),
		],
		tray: [
			{ type: 'stop', id: 'S-few', name: 'Few readings', observation_count: 2, severe_pct: 50 },
			{ type: 'route', id: 'R-few', name: 'Thin line', observation_count: 29, severe_pct: 10.3 },
		],
		total_ranked_routes: routes + 5,
		total_ranked_stops: 2,
		tray_total: 2,
		...overrides,
	};
}

describe('readHotspotRanking', () => {
	it('keeps the published order of one kind with its readings, shares and totals', () => {
		const shuffled = week(3);
		shuffled.entries = [...shuffled.entries].reverse();
		const ranking = readHotspotRanking(shuffled, 'route');

		expect(ranking.state).toBe('ranked');
		if (ranking.state !== 'ranked') return;
		expect(ranking.rows.map((row) => [row.position, row.id, row.latePct, row.readings])).toEqual([
			[1, 'route-1', 75, 40],
			[2, 'route-2', 70.7, 41],
			[3, 'route-3', 66.7, 42],
		]);
		expect(ranking.published).toBe(3);
		expect(ranking.eligible).toBe(8);
		expect(ranking.period).toEqual({ from: '2026-11-04', to: '2026-11-10', days: 7 });
	});

	it('passes the math checks on every row it returns', () => {
		for (const kind of ['route', 'stop'] as const) {
			const ranking = readHotspotRanking(week(), kind);
			if (ranking.state !== 'ranked') throw new Error('expected a ranking');
			expect(ranking.published).toBeLessThanOrEqual(ranking.eligible ?? Infinity);
			ranking.rows.forEach((row, index) => {
				expect(row.position).toBe(index + 1);
				expect(row.readings).toBeGreaterThanOrEqual(30);
				expect(row.latePct).toBeGreaterThanOrEqual(0);
				expect(row.latePct).toBeLessThanOrEqual(100);
				expect(Object.is(row.latePct, -0)).toBe(false);
			});
		}
	});

	it('reads a measured zero share as 0, never as -0, and keeps an unpublished share absent', () => {
		const grain = week(2);
		grain.entries[0] = { ...grain.entries[0], severe_count: 0, severe_pct: -0 };
		grain.entries[1] = { ...grain.entries[1], severe_count: null, severe_pct: null };
		const ranking = readHotspotRanking(grain, 'route');

		if (ranking.state !== 'ranked') throw new Error('expected a ranking');
		expect(Object.is(ranking.rows[0].latePct, 0)).toBe(true);
		expect(ranking.rows[1].latePct).toBeNull();
	});

	it.each([
		['a share above 100%', { severe_pct: 100.1 }],
		['a negative share', { severe_pct: -1 }],
		['a non-finite share', { severe_pct: Number.NaN }],
		['more late readings than readings', { severe_count: 41 }],
		['a share that does not follow from its counts', { severe_pct: 50 }],
		[
			'a ranked row under the 30-reading floor',
			{ observation_count: 29, severe_count: 1, severe_pct: 3.4 },
		],
		['a negative reading count', { observation_count: -40 }],
		['a fractional reading count', { observation_count: 40.5 }],
	])('refuses the whole ranking for %s', (_, change) => {
		const grain = week(2);
		grain.entries[0] = { ...grain.entries[0], ...change };
		expect(readHotspotRanking(grain, 'route').state).toBe('invalid');
	});

	it.each([
		['duplicate positions', (rows: HotspotEntry[]) => (rows[1] = { ...rows[1], rank: 1 })],
		['a gap in positions', (rows: HotspotEntry[]) => (rows[1] = { ...rows[1], rank: 3 })],
		['a missing position', (rows: HotspotEntry[]) => (rows[1] = { ...rows[1], rank: null })],
		[
			'an order the published bound contradicts',
			(rows: HotspotEntry[]) => (rows[0] = { ...rows[0], wilson_lo: 99 }),
		],
	])('refuses an order with %s', (_, corrupt) => {
		const grain = week(2);
		corrupt(grain.entries);
		expect(readHotspotRanking(grain, 'route').state).toBe('invalid');
	});

	it('refuses a ranking that publishes more rows than it says are eligible', () => {
		expect(readHotspotRanking(week(3, { total_ranked_routes: 2 }), 'route').state).toBe('invalid');
	});

	it('keeps an unpublished eligible total unknown instead of inventing it', () => {
		const ranking = readHotspotRanking(week(3, { total_ranked_routes: null }), 'route');
		if (ranking.state !== 'ranked') throw new Error('expected a ranking');
		expect(ranking.published).toBe(3);
		expect(ranking.eligible).toBeNull();
	});

	it('counts below-floor rows of one kind only when the published list is complete', () => {
		const complete = readHotspotRanking(week(), 'stop');
		if (complete.state !== 'ranked') throw new Error('expected a ranking');
		expect(complete.belowFloor.count).toBe(1);
		expect(complete.belowFloor.examples).toEqual([
			{ key: 'stop-S-few', id: 'S-few', name: 'Few readings', readings: 2 },
		]);

		const truncated = readHotspotRanking(week(12, { tray_total: 61 }), 'stop');
		if (truncated.state !== 'ranked') throw new Error('expected a ranking');
		expect(truncated.belowFloor.count).toBeNull();
		expect(truncated.belowFloor.examples).toHaveLength(1);

		const unknown = readHotspotRanking(week(12, { tray_total: null }), 'route');
		if (unknown.state !== 'ranked') throw new Error('expected a ranking');
		expect(unknown.belowFloor.count).toBeNull();
	});

	it('returns a published -0 count as 0 and keeps an unpublished count absent', () => {
		const grain = week(2, { total_ranked_routes: -0 + 2, tray_total: 2 });
		grain.tray = [
			{ type: 'route', id: 'R-zero', observation_count: -0 },
			{ type: 'route', id: 'R-null', observation_count: null },
		];
		const ranking = readHotspotRanking(grain, 'route');
		if (ranking.state !== 'ranked') throw new Error('expected a ranking');
		const [zero, absent] = ranking.belowFloor.examples;
		expect(Object.is(zero.readings, -0)).toBe(false);
		expect(zero.readings).toBe(0);
		expect(absent.readings).toBeNull();
	});

	it('drops an excluded list that contradicts its own floor', () => {
		const grain = week();
		grain.tray = [{ type: 'route', id: 'R-big', observation_count: 30 }];
		const ranking = readHotspotRanking(grain, 'route');
		if (ranking.state !== 'ranked') throw new Error('expected a ranking');
		expect(ranking.belowFloor).toEqual({ count: null, examples: [] });
	});

	it('says no row ranks when only excluded rows of that kind exist', () => {
		const ranking = readHotspotRanking(week(0, { total_ranked_routes: 0 }), 'route');
		expect(ranking.state).toBe('none');
		if (ranking.state !== 'none') return;
		expect(ranking.belowFloor.count).toBe(1);
	});

	it('reports a missing period as absent and unreadable dates as unknown', () => {
		expect(readHotspotRanking(undefined, 'route').state).toBe('absent');
		const ranking = readHotspotRanking(week(2, { date: null, window_end: null }), 'route');
		if (ranking.state !== 'ranked') throw new Error('expected a ranking');
		expect(ranking.period).toBeNull();
		const reversed = readHotspotRanking(
			week(2, { date: '2026-11-10', window_end: '2026-11-04' }),
			'route',
		);
		if (reversed.state !== 'ranked') throw new Error('expected a ranking');
		expect(reversed.period).toBeNull();
	});
});

describe('formatDayRange', () => {
	it.each([
		['2026-11-04', '2026-11-10', 'en', 'November 4 to 10, 2026'],
		['2026-11-04', '2026-11-10', 'fr', 'Du 4 au 10 novembre 2026'],
		['2026-10-12', '2026-11-10', 'en', 'October 12 to November 10, 2026'],
		['2026-10-12', '2026-11-10', 'fr', 'Du 12 octobre au 10 novembre 2026'],
		['2025-12-28', '2026-01-03', 'en', 'December 28, 2025 to January 3, 2026'],
		['2025-12-28', '2026-01-03', 'fr', 'Du 28 décembre 2025 au 3 janvier 2026'],
		['2026-11-01', '2026-11-07', 'fr', 'Du 1er au 7 novembre 2026'],
		['2026-11-10', '2026-11-10', 'en', 'November 10, 2026'],
		['2026-11-01', '2026-11-01', 'fr', 'Le 1er novembre 2026'],
	] as const)('%s to %s in %s reads "%s"', (from, to, locale, expected) => {
		expect(formatDayRange(from, to, locale)).toBe(expected);
	});
});
