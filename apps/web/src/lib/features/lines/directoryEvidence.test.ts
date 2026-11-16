import { describe, expect, it } from 'vitest';
import { createDirectoryComparison } from './directoryEvidence';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const STAMP = '2026-11-11T00:00:00Z';
const WINDOW = { window_start: '2026-11-04', window_end: '2026-11-10' };
const ranked = (id: string, numerator: number, denominator: number, pct: number, rank: number) => ({
	id,
	numerator,
	denominator,
	pct,
	rank,
	state: 'ranked' as const,
	...WINDOW,
});
const index = (rows: readonly unknown[]) => ({
	schema_version: 1,
	methodology_version: 'reliability-2',
	publish_generation_id: 'stm@2026-11-11T00:00:00Z',
	generated_utc: STAMP,
	weekly_routes: rows,
});

describe('directory published comparison admission', () => {
	it('normalizes negative-zero presentation without mutating the supplied evidence', () => {
		const row = ranked('zero', 0, 30, -0, 1);
		const result = createDirectoryComparison(index([row]))(NOW);
		expect(result?.ranked[0].pct).toBe(0);
		expect(Object.is(result?.ranked[0].pct, -0)).toBe(false);
		expect(Object.is(row.pct, -0)).toBe(true);
	});

	it('retains measured zero, counts, source order, exact week and supplied identity', () => {
		const rows = [
			ranked('zero', 0, 30, 0, 1),
			ranked('half', 15, 30, 50, 2),
			ranked('all', 30, 30, 100, 3),
		];
		const raw = index(rows);
		const before = JSON.stringify(raw);
		const result = createDirectoryComparison(raw)(NOW);
		expect(result?.ranked.map((row) => row.id)).toEqual(['zero', 'half', 'all']);
		expect(result?.ranked[0]).toMatchObject({ pct: 0, numerator: 0, denominator: 30 });
		expect(result?.period).toEqual({ from: '2026-11-04', to: '2026-11-10', days: 7 });
		expect(result?.publication).toEqual({
			generatedUtc: STAMP,
			generationId: raw.publish_generation_id,
			methodVersion: 'reliability-2',
		});
		expect(JSON.stringify(raw)).toBe(before);
	});

	it('keeps exclusions with their own dates and never treats them as zero figures', () => {
		const excluded = {
			id: 'unmeasured',
			state: 'no_live_data',
			window_start: '2026-10-28',
			window_end: '2026-11-03',
		};
		const result = createDirectoryComparison(index([ranked('measured', 15, 30, 50, 1), excluded]))(
			NOW,
		);
		expect(result?.entries).toContainEqual(excluded);
		expect(result?.ranked.map((row) => row.id)).toEqual(['measured']);
		expect(result?.entries[1].pct).toBeUndefined();
	});

	it('checks the actual ratios when shown whole percentages tie', () => {
		const low = ranked('lower', 200, 399, 50, 1);
		const high = ranked('higher', 167, 333, 50, 2);
		expect(200 * 333).toBeLessThan(167 * 399);
		expect(createDirectoryComparison(index([low, high]))(NOW)).not.toBeNull();
		expect(
			createDirectoryComparison(
				index([
					{ ...high, rank: 1 },
					{ ...low, rank: 2 },
				]),
			)(NOW),
		).toBeNull();
	});

	it('does not lose exact order when safe integer ratios collapse to one floating-point value', () => {
		const largest = Number.MAX_SAFE_INTEGER;
		const low = ranked('lower', largest - 2, largest - 1, 100, 1);
		const high = ranked('higher', largest - 1, largest, 100, 2);
		expect(low.numerator / low.denominator).toBe(high.numerator / high.denominator);
		expect(createDirectoryComparison(index([low, high]))(NOW)).not.toBeNull();
		expect(
			createDirectoryComparison(
				index([
					{ ...high, rank: 1 },
					{ ...low, rank: 2 },
				]),
			)(NOW),
		).toBeNull();
	});

	it('preserves exact ties without inventing a new tie order', () => {
		const rows = [ranked('b', 20, 30, 67, 1), ranked('a', 200, 300, 67, 1)];
		expect(createDirectoryComparison(index(rows))(NOW)?.ranked.map((row) => row.id)).toEqual([
			'b',
			'a',
		]);
	});

	it('refuses a descending supplied rank even when the figures ascend', () => {
		expect(
			createDirectoryComparison(index([ranked('a', 10, 100, 10, 2), ranked('b', 20, 100, 20, 1)]))(
				NOW,
			),
		).toBeNull();
	});

	it('refuses mixing two complete weeks in the ranked comparison', () => {
		expect(
			createDirectoryComparison(
				index([
					ranked('a', 10, 100, 10, 1),
					{ ...ranked('b', 20, 100, 20, 2), window_start: '2026-10-28', window_end: '2026-11-03' },
				]),
			)(NOW),
		).toBeNull();
	});

	it.each([
		{ numerator: 31, denominator: 30, pct: 100 },
		{ numerator: 0, denominator: 0, pct: 0 },
		{ numerator: -1, denominator: 30, pct: 0 },
		{ numerator: 1, denominator: Number.MAX_SAFE_INTEGER + 1, pct: 0 },
		{ numerator: 15, denominator: 30, pct: 0 },
		{ numerator: 15, denominator: 30, pct: Number.NaN },
		{ numerator: 15, denominator: 30, pct: Number.POSITIVE_INFINITY },
		{ numerator: 15, denominator: 30, pct: 101 },
	])('rejects invalid evidence or a figure that does not match its counts: %j', (invalid) => {
		expect(
			createDirectoryComparison(index([{ ...ranked('a', 15, 30, 50, 1), ...invalid }]))(NOW),
		).toBeNull();
	});

	it.each([null, {}, index([]), index([{ id: 'a', state: 'too_few_units', ...WINDOW }])])(
		'keeps an absent comparison unavailable: %j',
		(raw) => expect(createDirectoryComparison(raw)(NOW)).toBeNull(),
	);

	it('delegates future, stale and invalid-clock availability to the existing publication reader', () => {
		const read = createDirectoryComparison(index([ranked('a', 15, 30, 50, 1)]));
		expect(read(Date.parse('2026-11-10T23:59:59Z'))).toBeNull();
		expect(read(NOW)).not.toBeNull();
		expect(read(Date.parse('2026-11-30T12:00:00Z'))).toBeNull();
		expect(read(Number.NaN)).toBeNull();
	});

	it('does not manufacture missing publication generation or method metadata', () => {
		const result = createDirectoryComparison({
			generated_utc: STAMP,
			weekly_routes: [ranked('a', 15, 30, 50, 1)],
		})(NOW);
		expect(result?.publication).toEqual({
			generatedUtc: STAMP,
			generationId: null,
			methodVersion: null,
		});
	});

	it('refuses a week that was still incomplete on its publication day', () => {
		const row = {
			...ranked('a', 15, 30, 50, 1),
			window_start: '2026-11-05',
			window_end: '2026-11-11',
		};
		expect(createDirectoryComparison(index([row]))(NOW)).toBeNull();
	});

	it('does not read a legacy calendar stamp as a real midnight publication in the provider zone', () => {
		const read = createDirectoryComparison(index([ranked('a', 15, 30, 50, 1)]), 'America/Toronto');
		expect(read(Date.parse('2026-11-11T02:00:00Z'))).toBeNull();
		expect(read(Date.parse('2026-11-11T07:00:00Z'))).not.toBeNull();
	});

	it('uses the provider calendar for a real publication instant east of UTC', () => {
		const read = createDirectoryComparison(
			{
				generated_utc: '2026-11-16T11:59:00Z',
				published_utc: '2026-11-16T12:00:00Z',
				next_publish_utc: '2026-11-23T12:00:00Z',
				weekly_routes: [
					{ ...ranked('a', 15, 30, 50, 1), window_start: '2026-11-10', window_end: '2026-11-16' },
				],
			},
			'Pacific/Kiritimati',
		);
		expect(read(Date.parse('2026-11-16T12:05:00Z'))).not.toBeNull();
	});

	it('keeps an invalid provider calendar unavailable rather than silently assuming a zone', () => {
		expect(
			createDirectoryComparison(index([ranked('a', 15, 30, 50, 1)]), 'Not/AZone')(NOW),
		).toBeNull();
	});
});
