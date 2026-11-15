import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hotspots } from '#lib/v1/schemas/generated/historic_hotspots.ts';
import { selectWorst } from './homePulse';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';

describe('selectWorst', () => {
	const routes = createLineDirectory(
		[
			{ id: '7-354', short: '7', type: 3 },
			{ id: '11', short: '11', type: 3 },
		],
		{ line: (id) => `Line ${id}` },
	);
	const hotspots = {
		generated_utc: '2026-11-11T00:00:00Z',
		by_grain: [
			{
				grain: 'day',
				date: '2026-11-10',
				entries: [{ id: '99', type: 'route', rank: 1, observation_count: 30, severe_pct: 0 }],
			},
			{
				grain: 'week',
				date: '2026-11-04',
				window_end: '2026-11-10',
				entries: [
					{ id: 'S9', type: 'stop', rank: 3, name: 'RIDEAU / SUSSEX', severe_pct: 21.5 },
					{
						id: '11',
						type: 'route',
						rank: 2,
						name: 'Waller <> Bayshore',
						severe_pct: 19,
						observation_count: 100,
					},
					{
						id: '7-354',
						type: 'route',
						rank: 1,
						name: 'Carleton <> St-Laurent',
						severe_pct: 24,
						observation_count: 100,
					},
					{ id: 'S1', type: 'stop', rank: 4, name: null, severe_pct: null },
				],
			},
		],
	} as Hotspots;

	it('ranks the published week: lines by number first, stops by readable name', () => {
		const worst = selectWorst(hotspots, routes);
		expect(worst?.through).toBe('2026-11-10');
		expect(worst?.lines.map((line) => line.label)).toEqual([
			'7 · Carleton <> St-Laurent',
			'11 · Waller <> Bayshore',
		]);
		expect(worst?.stops.map((stop) => [stop.id, stop.label, stop.severePct])).toEqual([
			['S9', 'Rideau / Sussex', 21.5],
			['S1', 'S1', null],
		]);
	});
	it('keeps the published week through the scheduled next publication plus its completion allowance', () => {
		for (const now of ['2026-11-18T07:30:00Z', '2026-11-18T08:01:00Z', '2026-11-19T18:59:59.999Z'])
			expect(
				selectWorst(hotspots, routes, { now: Date.parse(now) })?.lines.map((line) => line.id),
			).toEqual(['7-354', '11']);
		expect(selectWorst(hotspots, routes, { now: Date.parse('2026-11-19T19:00:00Z') })).toBeNull();
	});
	it.each([NaN, Infinity, Date.parse('2026-11-10T23:59:59Z'), Date.parse('2026-11-20T00:00:00Z')])(
		'rejects an invalid, future or overdue clock (%s)',
		(now) => {
			expect(selectWorst(hotspots, routes, { now })).toBeNull();
		},
	);
	it('rejects an invalid publication date', () => {
		expect(selectWorst({ ...hotspots, generated_utc: 'invalid' } as Hotspots, routes)).toBeNull();
	});

	it('keeps the first of any repeated entry, so a malformed file cannot break the list', () => {
		const repeated = {
			...hotspots,
			by_grain: [
				{
					grain: 'week',
					entries: [
						{
							id: '11',
							type: 'route',
							rank: 1,
							name: 'Waller <> Bayshore',
							severe_pct: 30,
							observation_count: 100,
						},
						{
							id: '11',
							type: 'route',
							rank: 2,
							name: 'Waller <> Bayshore',
							severe_pct: 20,
							observation_count: 100,
						},
						{ id: '11', type: 'stop', rank: 3, name: 'STOP ELEVEN', severe_pct: 10 },
					],
				},
			],
		} as Hotspots;
		const worst = selectWorst(repeated, routes);
		expect(worst?.lines.map((line) => [line.id, line.severePct])).toEqual([['11', 30]]);
		expect(worst?.stops.map((stop) => stop.id)).toEqual(['11']);
	});

	it('caps each list and reports absence when no daily ranking is published', () => {
		expect(selectWorst(hotspots, routes, { limit: 1 })?.lines).toHaveLength(1);
		expect(selectWorst(hotspots, routes, { grain: 'day' })?.lines.map((l) => l.id)).toEqual(['99']);
		expect(selectWorst({ ...hotspots, by_grain: [] }, routes)).toBeNull();
		expect(selectWorst(null, routes)).toBeNull();
	});
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
