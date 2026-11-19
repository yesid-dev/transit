import { describe, expect, it } from 'vitest';
import {
	FINDER_PAGE_SIZE,
	finderSearchParams,
	lineRows,
	nearRows,
	networkRows,
	nextPageSize,
	parseFinderState,
	providerHref,
	publishedOrderRows,
	stopRecordHref,
} from './finderState';

const stop = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
	id,
	name,
	code: id,
	lat: 45.5,
	lon: -73.6,
	...extra,
});
const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;
const ids = (rows: { stop: { id: string } }[]) => rows.map((row) => row.stop.id);

describe('finder URL state', () => {
	it('reads every control and writes back only what differs from the defaults', () => {
		const state = parseFinderState(
			new URLSearchParams('q=Berri%0A&route=24&sort=late&stop=52409&shown=40'),
		);
		expect(state).toEqual({ query: 'Berri', route: '24', order: 'late', stop: '52409', shown: 40 });
		expect(finderSearchParams(state)).toEqual({
			q: 'Berri',
			route: '24',
			sort: 'late',
			stop: '52409',
			shown: '40',
		});
		expect(finderSearchParams(parseFinderState(new URLSearchParams()))).toEqual({
			q: null,
			route: null,
			sort: null,
			stop: null,
			shown: null,
		});
	});

	it.each(['0', '-20', '25', '1e3', 'all'])(
		'drops a page size the control cannot write: %s',
		(shown) => {
			expect(parseFinderState(new URLSearchParams({ shown })).shown).toBe(FINDER_PAGE_SIZE);
		},
	);

	it('states the last increment at its real size', () => {
		expect(nextPageSize(20, 41)).toBe(20);
		expect(nextPageSize(40, 41)).toBe(1);
		expect(nextPageSize(60, 41)).toBe(0);
	});
});

describe('finder rows', () => {
	const stops = [
		stop('3', 'Berri-UQAM'),
		stop('1', 'Atwater'),
		stop('2', 'Berri / Sainte-Catherine'),
		stop('4', 'Atwater', { code: '10' }),
	];

	it('lists every stop by name, keeping same-named stops apart', () => {
		expect(ids(networkRows(stops, '', compare))).toEqual(['1', '4', '2', '3']);
	});

	it('keeps every match for a query, best first', () => {
		expect(ids(networkRows(stops, 'berri', compare))).toEqual(['2', '3']);
		expect(networkRows(stops, 'zzz', compare)).toEqual([]);
	});

	it('follows a line in travel order and names directions only by their published headsign', () => {
		const rows = lineRows(
			{
				directions: [
					{
						dir: 0,
						headsign: 'Côte-Vertu',
						stops: [
							{ id: '2', seq: 2 },
							{ id: '1', seq: 1 },
						],
					},
					{
						dir: 1,
						headsign: null,
						stops: [
							{ id: '1', seq: 1 },
							{ id: '9', seq: 2, name: 'Not in the index' },
						],
					},
				],
			} as never,
			stops,
			'',
		);
		expect(rows.map((row) => [row.stop.id, row.towards])).toEqual([
			['1', 'Côte-Vertu'],
			['2', 'Côte-Vertu'],
			['1', null],
			['9', null],
		]);
		expect(rows[3].stop.name).toBe('Not in the index');
		expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
	});

	it('puts the publisher’s ranked stops first in its own order and keeps every other row', () => {
		const rows = networkRows(stops, '', compare);
		expect(ids(publishedOrderRows(rows, ['3', 'gone', '1']))).toEqual(['3', '1', '4', '2']);
	});

	it('lists stops within 1 km, nearest first, with their distance', () => {
		const origin = { lat: 45.5, lon: -73.6 };
		const rows = nearRows(
			origin,
			[
				stop('far', 'Far', { lat: 45.52 }), // about 2.2 km
				stop('near', 'Near', { lat: 45.503 }), // about 330 m
				stop('here', 'Here'),
				stop('nowhere', 'No position', { lat: Number.NaN }),
			],
			'',
		);
		expect(ids(rows)).toEqual(['here', 'near']);
		expect(rows[0].distanceM).toBe(0);
		expect(Math.round(rows[1].distanceM!)).toBe(334);
	});
});

describe('finder links', () => {
	const base = new URL(
		'https://transit.example/fr/stops?provider=stm&q=berri&route=24&stop=1&embed=1',
	);

	it('opens the record on the row’s week with the reader’s provider, dropping the finder’s view', () => {
		expect(
			stopRecordHref({
				base,
				path: '/fr/stop/52409?provider=octranspo',
				providerId: 'stm',
				window: { from: '2026-11-04', to: '2026-11-10' },
			}),
		).toBe('/fr/stop/52409?provider=stm&embed=1&from=2026-11-04&to=2026-11-10');
		expect(stopRecordHref({ base, path: '/fr/stop/52409', providerId: 'stm', window: null })).toBe(
			'/fr/stop/52409?provider=stm&embed=1',
		);
	});

	it('keeps the map’s own stop filter and adds the provider', () => {
		expect(providerHref({ base, path: '/fr/map?stop=52409', providerId: 'stm' })).toBe(
			'/fr/map?stop=52409&provider=stm',
		);
	});
});
