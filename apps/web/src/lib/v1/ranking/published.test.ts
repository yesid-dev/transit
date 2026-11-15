import { describe, expect, it } from 'vitest';
import { RouteReliabilityIndexSchema } from '#lib/v1/schemas/route_reliability_index.ts';
import { publishedOrder, publishedWeeklyRanking } from './published';

describe('published weekly ranking', () => {
	it('keeps publisher order through filtering and never sorts by arriving badges', () => {
		expect(publishedOrder(['a', 'b', 'c'], (id) => id, ['c', 'b', 'a'])).toEqual(['c', 'b', 'a']);
		expect(publishedOrder(['a', 'c'], (id) => id, ['c', 'b', 'a'])).toEqual(['c', 'a']);
	});
	it('offers no league for missing, stale or malformed publication', () => {
		const index = RouteReliabilityIndexSchema.parse({
			generated_utc: '2026-11-14T00:00:00Z',
			weekly_routes: [],
		});
		expect(publishedWeeklyRanking(index, 'route', Date.parse('2026-11-14T01:00:00Z'))).toEqual([]);
		expect(publishedWeeklyRanking(index, 'route', Date.parse('2026-11-16T00:00:00Z'))).toBeNull();
		expect(publishedWeeklyRanking(index, 'stop')).toBeNull();
		expect(publishedWeeklyRanking(null, 'route')).toBeNull();
		expect(
			RouteReliabilityIndexSchema.safeParse({ generated_utc: 'bad', weekly_routes: {} }).success,
		).toBe(false);
	});
});
