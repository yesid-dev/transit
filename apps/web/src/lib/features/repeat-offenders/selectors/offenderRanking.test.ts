import { describe, expect, it } from 'vitest';
import type { RepeatOffenderEntry } from '#lib/v1/schemas/index.ts';
import { readOffenderRanking, type OffenderGrainSource } from './offenderRanking';

/** The publisher's share: 100 × late / readings, half away from zero to one decimal. */
const share = (late: number, readings: number) => Math.round((1000 * late) / readings) / 10;

/**
 * One row as the publisher writes it. Its Wilson bounds describe the not-late share, so the
 * late-share interval is [100 − hi, 100 − lo]; the seed keeps it around the share.
 */
function seedRow(
	type: 'trip' | 'vehicle',
	rank: number | null,
	over: Partial<RepeatOffenderEntry> = {},
): RepeatOffenderEntry {
	const readings = over.observation_count ?? 90;
	const late = over.severe_count ?? 60;
	const pct = readings > 0 ? share(late, readings) : null;
	return {
		rank,
		type,
		id: `${type}-${rank ?? 'x'}`,
		route: '36',
		route_name: 'Monk',
		observation_count: readings,
		severe_count: late,
		severe_pct: pct,
		wilson_lo: pct == null ? null : Math.max(0, Math.round((100 - pct - 8) * 10) / 10),
		wilson_hi: pct == null ? null : Math.min(100, Math.round((100 - pct + 8) * 10) / 10),
		recurrence_days: 4 - Math.min(rank ?? 0, 2),
		observed_days: 5,
		window_days: 7,
		avg_delay_min: 20 - (rank ?? 0),
		...over,
	};
}

function seedGrain(over: Partial<OffenderGrainSource> = {}): OffenderGrainSource {
	return {
		date: '2026-11-04',
		window_end: '2026-11-10',
		window_days: 7,
		entries: [seedRow('trip', 1), seedRow('trip', 2), seedRow('trip', 3), seedRow('vehicle', 1)],
		tray: [
			seedRow('vehicle', null, {
				id: '4672',
				observation_count: 29,
				severe_count: 21,
				recurrence_days: 2,
				observed_days: 2,
				wilson_lo: null,
				wilson_hi: null,
			}),
		],
		total_ranked_trips: 120,
		total_ranked_vehicles: 1,
		tray_total: 1,
		...over,
	};
}

const ranked = (grain: OffenderGrainSource, kind: 'trip' | 'vehicle' = 'trip') => {
	const result = readOffenderRanking(grain, kind);
	if (result.state !== 'ranked') throw new Error(`Expected a ranking, got ${result.state}`);
	return result;
};

describe('readOffenderRanking', () => {
	it('keeps the published order and positions with shown, published and eligible totals', () => {
		const result = ranked(seedGrain());
		expect(result.rows.map((row) => [row.position, row.entry.id])).toEqual([
			[1, 'trip-1'],
			[2, 'trip-2'],
			[3, 'trip-3'],
		]);
		expect(result.published).toBe(3);
		expect(result.eligible).toBe(120);
		expect(result.period).toEqual({ from: '2026-11-04', to: '2026-11-10', days: 7 });
		expect(result.earlierRule).toBe(false);
	});

	it('converts the published bounds to the late-share interval once, around the share', () => {
		const row = ranked(seedGrain()).rows[0];
		// Seeded share 66.7 %, on-time bounds 25.3–41.3.
		expect(row.figures.latePct).toBe(66.7);
		expect(row.figures.interval).toEqual({ lower: 58.7, upper: 74.7 });
		for (const { figures } of ranked(seedGrain()).rows) {
			const { lower, upper } = figures.interval!;
			expect(lower).toBeLessThanOrEqual(figures.latePct!);
			expect(upper).toBeGreaterThanOrEqual(figures.latePct!);
			expect(0 <= lower && upper <= 100).toBe(true);
		}
	});

	it('holds every figure to its definition (owner ruling 6)', () => {
		const result = ranked(seedGrain());
		for (const { figures } of result.rows) {
			for (const value of Object.values(figures)) {
				if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
			}
			expect(figures.lateReadings!).toBeLessThanOrEqual(figures.readings!);
			expect(figures.lateDays!).toBeLessThanOrEqual(figures.observedDays!);
			expect(figures.observedDays!).toBeLessThanOrEqual(figures.windowDays!);
		}
	});

	it.each([
		['a share that does not follow from its counts', { severe_pct: 66.8 }],
		['more late readings than readings', { severe_count: 91, severe_pct: 101.1 }],
		['a negative count', { observation_count: -1 }],
		['a fractional count', { observed_days: 4.5 }],
		['more late days than observed days', { recurrence_days: 6 }],
		['more observed days than the window', { observed_days: 8 }],
		['late readings with no late day', { recurrence_days: 0 }],
		['an infinite average delay', { avg_delay_min: Number.POSITIVE_INFINITY }],
		['an interval that excludes the share', { wilson_lo: 60, wilson_hi: 70 }],
		['inverted bounds', { wilson_lo: 41.3, wilson_hi: 25.3 }],
	])('refuses the whole ranking for %s', (_case, over) => {
		const grain = seedGrain({
			entries: [seedRow('trip', 1), seedRow('trip', 2, over as Partial<RepeatOffenderEntry>)],
		});
		expect(readOffenderRanking(grain, 'trip').state).toBe('invalid');
	});

	it('checks the share with the publisher’s exact rounding, half away from zero', () => {
		// 1 of 8 is 12.5 %; 1 of 16 is exactly 6.25 %, published as 6.3.
		const exact = seedRow('trip', 1, {
			observation_count: 160,
			severe_count: 10,
			severe_pct: 6.3,
			wilson_lo: 89.4,
			wilson_hi: 96.6,
		});
		expect(readOffenderRanking(seedGrain({ entries: [exact] }), 'trip').state).toBe('ranked');
		const truncated = { ...exact, severe_pct: 6.2 };
		expect(readOffenderRanking(seedGrain({ entries: [truncated] }), 'trip').state).toBe('invalid');
	});

	it.each([
		['a gap', [1, 3]],
		['a duplicate', [1, 1]],
		['a ranking that starts after 1', [2, 3]],
	])('refuses published positions with %s', (_case, ranks) => {
		const grain = seedGrain({ entries: ranks.map((rank) => seedRow('trip', rank)) });
		expect(readOffenderRanking(grain, 'trip').state).toBe('invalid');
	});

	it('refuses an order that contradicts late days, then average delay', () => {
		const fewerLateDaysFirst = seedGrain({
			entries: [
				seedRow('trip', 1, { recurrence_days: 2 }),
				seedRow('trip', 2, { recurrence_days: 3 }),
			],
		});
		expect(readOffenderRanking(fewerLateDaysFirst, 'trip').state).toBe('invalid');
		const shorterDelayFirst = seedGrain({
			entries: [
				seedRow('trip', 1, { recurrence_days: 3, avg_delay_min: 9 }),
				seedRow('trip', 2, { recurrence_days: 3, avg_delay_min: 9.1 }),
			],
		});
		expect(readOffenderRanking(shorterDelayFirst, 'trip').state).toBe('invalid');
		const tiedDisplay = seedGrain({
			entries: [
				seedRow('trip', 1, { recurrence_days: 3, avg_delay_min: 9 }),
				seedRow('trip', 2, { recurrence_days: 3, avg_delay_min: 9 }),
			],
		});
		// Equal displayed minutes can come from different unrounded means.
		expect(readOffenderRanking(tiedDisplay, 'trip').state).toBe('ranked');
	});

	it('refuses more published rows than the eligible total', () => {
		expect(readOffenderRanking(seedGrain({ total_ranked_trips: 2 }), 'trip').state).toBe('invalid');
	});

	it('leaves an unpublished eligible total unknown, never zero', () => {
		const result = ranked(seedGrain({ total_ranked_trips: null }));
		expect(result.eligible).toBeNull();
	});

	it('lists a published row below the rule as not ranked, with its own reasons', () => {
		const result = ranked(seedGrain(), 'vehicle');
		expect(result.unranked.rows.map((row) => [row.entry.id, row.reasons])).toEqual([
			['4672', ['readings', 'observedDays']],
		]);
		expect(result.unranked.complete).toBe(true);
	});

	it.each([
		[
			'readings',
			{ observation_count: null, severe_count: null, severe_pct: null },
			'readingsUnknown',
		],
		['days seen', { observed_days: null }, 'observedDaysUnknown'],
		['late days', { recurrence_days: null }, 'lateDaysUnknown'],
	] as const)(
		'keeps a row with unpublished %s unranked as unknown, never as fewer than the floor',
		(_case, over, unknown) => {
			const row = seedRow('trip', null, { wilson_lo: null, wilson_hi: null, ...over });
			const result = readOffenderRanking(seedGrain({ entries: [], tray: [row] }), 'trip');
			if (result.state !== 'none') throw new Error('Expected no ranked trip');
			expect(result.unranked.rows[0].reasons).toEqual([unknown]);
		},
	);

	it('says fewer than the floor only for a published count below it, zero included', () => {
		const zero = seedRow('trip', null, {
			observation_count: 0,
			severe_count: 0,
			severe_pct: null,
			wilson_lo: null,
			wilson_hi: null,
			recurrence_days: 0,
			observed_days: 0,
		});
		const result = readOffenderRanking(seedGrain({ entries: [], tray: [zero] }), 'trip');
		if (result.state !== 'none') throw new Error('Expected no ranked trip');
		expect(result.unranked.rows[0].reasons).toEqual(['readings', 'observedDays', 'lateDays']);
	});

	it('moves rows ranked under an earlier rule to not ranked and keeps the publisher’s numbers', () => {
		// Today’s files: a one-day trip ranked first by the earlier rule.
		const grain = seedGrain({
			entries: [
				seedRow('trip', 1, { recurrence_days: 1, observed_days: 1, avg_delay_min: 50 }),
				seedRow('trip', 2, { recurrence_days: 3, observed_days: 4 }),
			],
		});
		const result = ranked(grain);
		expect(result.earlierRule).toBe(true);
		expect(result.rows.map((row) => row.position)).toEqual([2]);
		expect(result.eligible).toBeNull();
		expect(result.unranked.rows[0].reasons).toEqual(['observedDays', 'lateDays']);
	});

	it('says no row ranks when every published row predates the rule', () => {
		const grain = seedGrain({
			entries: [
				seedRow('trip', 1, { recurrence_days: 1, observed_days: 1 }),
				seedRow('trip', 2, { recurrence_days: 2, observed_days: 2 }),
			],
		});
		const result = readOffenderRanking(grain, 'trip');
		expect(result.state).toBe('none');
		if (result.state !== 'none') return;
		expect(result.earlierRule).toBe(true);
		expect(result.unranked.rows).toHaveLength(2);
	});

	it('knows the not-ranked list is partial when the record lists fewer than it counts', () => {
		const result = ranked(seedGrain({ tray_total: 7 }), 'vehicle');
		expect(result.unranked.complete).toBe(false);
	});

	it('reads a published negative zero as zero and keeps absent figures absent', () => {
		const zero = seedRow('trip', null, {
			severe_count: 0,
			severe_pct: -0,
			recurrence_days: 0,
			wilson_lo: 96,
			wilson_hi: 100,
			avg_delay_min: -0,
		});
		const result = readOffenderRanking(seedGrain({ entries: [], tray: [zero] }), 'trip');
		if (result.state !== 'none') throw new Error('Expected no ranked trip');
		const figures = result.unranked.rows[0].figures;
		expect(Object.is(figures.latePct, -0)).toBe(false);
		expect(Object.is(figures.averageDelayMin, -0)).toBe(false);
		expect(Object.is(figures.lateReadings, -0)).toBe(false);
		const absent = readOffenderRanking(
			seedGrain({
				entries: [seedRow('trip', 1, { avg_delay_min: null, wilson_lo: null, wilson_hi: null })],
			}),
			'trip',
		);
		if (absent.state !== 'ranked') throw new Error('Expected a ranking');
		expect(absent.rows[0].figures.averageDelayMin).toBeNull();
		expect(absent.rows[0].figures.interval).toBeNull();
	});

	it('reads the period length from the file when its dates are not published', () => {
		const result = ranked(seedGrain({ date: null, window_end: null }));
		expect(result.period).toBeNull();
		expect(result.windowDays).toBe(7);
		// A row's window must be the period's window.
		const month = seedGrain({ date: null, window_end: null, window_days: 30 });
		expect(readOffenderRanking(month, 'trip').state).toBe('invalid');
	});

	it('reports an absent period and a published period with no row of this kind', () => {
		expect(readOffenderRanking(null, 'trip').state).toBe('absent');
		expect(readOffenderRanking(seedGrain({ entries: [], tray: [] }), 'vehicle').state).toBe('none');
	});
});
