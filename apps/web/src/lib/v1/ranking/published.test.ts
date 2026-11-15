import { describe, expect, it } from 'vitest';
import { RouteReliabilityIndexSchema } from '#lib/v1/schemas/route_reliability_index.ts';
import { publishedOrder, publishedWeeklyRanking } from './published';

const validRow = {
	id: 'R',
	state: 'ranked',
	rank: 1,
	numerator: 18,
	denominator: 30,
	pct: 60,
	window_start: '2026-11-04',
	window_end: '2026-11-10',
};
it.each([
	{ state: 'invented' },
	{ rank: null },
	{ rank: 0 },
	{ numerator: -1 },
	{ denominator: -1 },
	{ denominator: 29 },
	{ pct: 300 },
	{ pct: 59 },
	{ numerator: 31 },
	{ window_end: 'banana' },
	{ window_end: '2026-11-31' },
	{ window_start: '2026-11-11' },
	{ window_start: '2026-11-03' },
	{ numerator: undefined },
	{ severe_pct: 41 },
	{ state: 'too_few_units', rank: null },
])('rejects an invalid row together with the rest of the ranking', (invalid) => {
	const index = {
		generated_utc: '2026-11-11T00:00:00Z',
		weekly_routes: [validRow, { ...validRow, id: 'bad', ...invalid }],
	};
	expect(RouteReliabilityIndexSchema.safeParse(index).success).toBe(false);
	expect(
		publishedWeeklyRanking(index as never, 'route', Date.parse('2026-11-12T00:00:00Z')),
	).toBeNull();
});
it.each([
	[20, 30, 67, 33.3],
	[100, 110, 91, 9.1],
	[10, 30, 33, 66.7],
])('accepts consistent fractional stop rates', (numerator, denominator, pct, severe_pct) => {
	const row = { ...validRow, numerator, denominator, pct, severe_pct };
	const index = RouteReliabilityIndexSchema.parse({
		generated_utc: '2026-11-11T00:00:00Z',
		weekly_stops: [row],
	});
	expect(
		publishedWeeklyRanking(index, 'stop', Date.parse('2026-11-12T00:00:00Z'))?.[0].severe_pct,
	).toBe(severe_pct);
});
describe('published weekly ranking', () => {
	it('keeps publisher order through filtering and never sorts by arriving badges', () => {
		expect(publishedOrder(['a', 'b', 'c'], (id) => id, ['c', 'b', 'a'])).toEqual(['c', 'b', 'a']);
		expect(publishedOrder(['a', 'c'], (id) => id, ['c', 'b', 'a'])).toEqual(['c', 'a']);
	});
	it.each([
		{ rows: [] },
		{
			rows: [
				{
					id: 'R',
					state: 'too_few_units',
					pct: null,
					window_start: '2026-11-04',
					window_end: '2026-11-10',
				},
			],
		},
	])('offers no league when no row is eligible', ({ rows }) => {
		const now = Date.parse('2026-11-14T01:00:00Z');
		const index = RouteReliabilityIndexSchema.parse({
			generated_utc: '2026-11-14T00:00:00Z',
			weekly_routes: rows,
		});
		expect(publishedWeeklyRanking(index, 'route', now)).toBeNull();
	});
	it('keeps a Wednesday publication through the next scheduled publication, then refuses it', () => {
		const index = RouteReliabilityIndexSchema.parse({
			generated_utc: '2026-11-11T00:00:00Z',
			weekly_routes: [validRow],
		});
		for (const now of ['2026-11-12T12:00:00Z', '2026-11-15T04:00:00Z', '2026-11-18T06:59:59Z'])
			expect(publishedWeeklyRanking(index, 'route', Date.parse(now))).not.toBeNull();
		expect(publishedWeeklyRanking(index, 'route', Date.parse('2026-11-18T07:00:00Z'))).toBeNull();
	});
	it('uses the contract publication deadline when supplied', () => {
		const index = RouteReliabilityIndexSchema.parse({
			generated_utc: '2026-11-11T00:00:00Z',
			published_utc: '2026-11-11T08:00:00Z',
			next_publish_utc: '2026-11-18T08:00:00Z',
			weekly_routes: [validRow],
		});
		expect(
			publishedWeeklyRanking(index, 'route', Date.parse('2026-11-18T07:30:00Z')),
		).not.toBeNull();
		expect(publishedWeeklyRanking(index, 'route', Date.parse('2026-11-18T08:00:00Z'))).toBeNull();
	});
	it('offers no league for missing, stale or malformed publication', () => {
		const index = RouteReliabilityIndexSchema.parse({
			generated_utc: '2026-11-14T00:00:00Z',
			weekly_routes: [validRow],
		});
		expect(publishedWeeklyRanking(index, 'route', Date.parse('2026-11-14T01:00:00Z'))).toEqual(
			index.weekly_routes,
		);
		expect(publishedWeeklyRanking(index, 'route', Date.parse('2026-11-19T00:00:00Z'))).toBeNull();
		expect(publishedWeeklyRanking(index, 'stop')).toBeNull();
		expect(publishedWeeklyRanking(null, 'route')).toBeNull();
		expect(
			RouteReliabilityIndexSchema.safeParse({ generated_utc: 'bad', weekly_routes: {} }).success,
		).toBe(false);
	});
});
