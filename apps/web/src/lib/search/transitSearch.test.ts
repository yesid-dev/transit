import { expect, it, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));
import {
	canSearchAddresses,
	searchTransit,
	withAddresses,
	type SearchSources,
} from './transitSearch';
import type { Vehicle } from '#lib/v1/schemas/index.ts';
import type { StopIndexEntry } from '#lib/v1/schemas/index.ts';
const vehicle = (id: string): Vehicle => ({
	id,
	lat: 0,
	lon: 0,
	status: 'late',
	updated_utc: '2026-06-16T00:00:00Z' as Vehicle['updated_utc'],
});
const resultIds = (items: readonly { id: string }[]) => items.map(({ id }) => id);

it('keeps unknown modes only without a mode selection', () => {
	const query = 'hub';
	const sources = { routes: [{ id: 'unknown', short: '?', long: 'Hub', type: 999 }] };
	const modes = new Set(['bus'] as const);
	expect(searchTransit({ surface: 'page', query }, sources).routes).toEqual(sources.routes);
	expect(searchTransit({ surface: 'page', query, modes }, sources).routes).toEqual([]);
});

it.each([
	['CRÉMAZIE', 'c', 'Station Crémazie'],
	['cremazie', 'c', 'Station Crémazie'],
	['Berri-UQAM', 'b', 'Station Berri-UQAM'],
	['uqam berri', 'b', 'Station Berri-UQAM'],
])('matches accents and punctuation without changing labels: %s', (query, id, label) => {
	const stops = [
		{ id: 'c', code: '300', name: 'Station Crémazie', lat: 0, lon: 0 },
		{ id: 'b', code: '100', name: 'Station Berri-UQAM', lat: 0, lon: 0 },
	];
	const page = searchTransit({ surface: 'page', query }, { stops });
	expect(resultIds(page.stops)).toEqual([id]);
	expect(page.stops[0].name).toBe(label);
});

it('accepts absent sources without inventing results', () => {
	for (const sources of [{}, { routes: null, stops: null, vehicles: null }]) {
		for (const [query, folded] of [
			['hub', 'hub'],
			['', ''],
			['   ', ''],
			['---', ''],
		]) {
			expect(searchTransit({ surface: 'page', query }, sources)).toEqual({
				query: folded,
				routes: [],
				stops: [],
				vehicles: [],
			});
		}
	}
});

it('does not mutate inputs', () => {
	const routes = Object.freeze([Object.freeze({ id: 'r', short: '1', long: 'Hub', type: 3 })]);
	const stops = Object.freeze([
		Object.freeze({ id: 's', code: '1', name: 'Hub', mode: 'bus' as const, lat: 0, lon: 0 }),
	]);
	const vehicles = Object.freeze([Object.freeze(vehicle('hub'))]);
	const sources = Object.freeze({ routes, stops, vehicles });
	const before = JSON.stringify(sources);
	const modes = new Set(['bus'] as const);
	const page = searchTransit({ surface: 'page', query: 'hub', modes }, sources);
	expect(page.routes[0]).toBe(routes[0]);
	expect(page.stops[0]).toBe(stops[0]);
	expect(page.vehicles[0]).toBe(vehicles[0]);
	expect(JSON.stringify(sources)).toBe(before);
	expect([...modes]).toEqual(['bus']);
});

it('returns every match on the page surface', () => {
	const routes = Array.from({ length: 51 }, (_, i) => ({
		id: String(i),
		short: String(i),
		long: 'Hub',
		type: 3,
	}));
	const stops = Array.from({ length: 51 }, (_, i) => ({
		id: String(i),
		code: String(i),
		name: 'Hub',
		lat: 0,
		lon: 0,
	}));
	const page = searchTransit({ surface: 'page', query: 'hub' }, { routes, stops });
	expect(page.routes).toHaveLength(51);
	expect(page.stops).toHaveLength(51);
});

it('preserves mode filtering relative to stop deduplication', () => {
	const stops: StopIndexEntry[] = [
		{ id: 'rail-first', code: 'r', name: 'Station Central', lat: 0, lon: 0, mode: 'rail' },
		{ id: 'metro-second', code: 'm', name: 'Station Central', lat: 0, lon: 0, mode: 'metro' },
	];
	const modes = new Set(['metro'] as const);
	expect(searchTransit({ surface: 'page', query: 'central', modes }, { stops }).stops).toEqual([]);
});

it('keeps source order for tied lines and stops', () => {
	const routes = [
		{ id: 'z', short: '20', long: 'Café', type: 3 },
		{ id: 'a', short: '3', long: 'Café', type: 3 },
	];
	const stops = [
		{ id: 'z', code: 'z', name: 'Zulu Hub', lat: 0, lon: 0 },
		{ id: 'a', code: 'a', name: 'Alpha Hub', lat: 0, lon: 0 },
	];
	expect(resultIds(searchTransit({ surface: 'page', query: 'café' }, { routes }).routes)).toEqual([
		'z',
		'a',
	]);
	expect(resultIds(searchTransit({ surface: 'page', query: 'hub' }, { stops }).stops)).toEqual([
		'z',
		'a',
	]);
});

it("keeps exact, prefix, substring and reversed-token matches in today's order", () => {
	const routes = ['x hub', 'hub north', 'hub', 'hub x'].map((long, i) => ({
		id: `r${i}`,
		short: `n${i}`,
		long,
		type: 3,
	}));
	const vehicles: Vehicle[] = [vehicle('40061')];
	for (const [query, ids] of [
		['hub', ['r2', 'r1', 'r3', 'r0']],
		['x hub', ['r0', 'r3']],
		['n1', ['r1']],
		['r1', ['r1']],
	] as const) {
		expect(resultIds(searchTransit({ surface: 'page', query }, { routes }).routes)).toEqual(ids);
	}
	for (const query of ['400', '40061']) {
		const ids = query === '40061' ? ['40061'] : [];
		expect(resultIds(searchTransit({ surface: 'page', query }, { vehicles }).vehicles)).toEqual(
			ids,
		);
	}
});

const hubs = (n: number) => ({
	routes: Array.from({ length: n }, (_, i) => ({
		id: `r${i}`,
		short: `${i}`,
		long: 'Hub',
		type: 3,
	})),
	stops: Array.from({ length: n }, (_, i) => ({
		id: `s${i}`,
		code: `c${i}`,
		name: `Hub ${i}`,
		lat: 0,
		lon: 0,
	})),
});
const shape = (list: {
	groups: readonly { kind: string; total: number; hits: readonly unknown[] }[];
}) => list.groups.map((group) => `${group.kind} ${group.hits.length}/${group.total}`);

it('returns true totals beyond the cap', () => {
	const list = searchTransit({ surface: 'list', query: 'hu', scope: 'all' }, hubs(38));
	expect(shape(list)).toEqual(['route 4/38', 'stop 4/38']);
	expect(list.total).toBe(76);
});

it('the page decides the order, never what is searched', () => {
	const order = (scope: 'route' | 'stop' | 'map' | 'all') =>
		shape(searchTransit({ surface: 'list', query: 'hu', scope }, hubs(38)));
	expect(order('route')).toEqual(['route 6/38', 'stop 2/38']);
	expect(order('stop')).toEqual(['stop 6/38', 'route 2/38']);
	expect(order('map')).toEqual(['route 4/38', 'stop 4/38']);
	expect(order('all')).toEqual(['route 4/38', 'stop 4/38']);
});

it('adds the addresses asked for last, two at most, outside the /search count', () => {
	const address = {
		lat: 45,
		lon: -73,
		label: 'Hub Street',
		source: 'geo_ca',
		precision: 'street',
	} as const;
	const list = searchTransit(
		{ surface: 'list', query: 'hub', scope: 'all' },
		{
			...hubs(3),
			vehicles: [vehicle('HUB'), vehicle('hub')],
		},
	);
	const found = withAddresses(list, [address, address, address]);
	expect(shape(found)).toEqual(['route 3/3', 'stop 3/3', 'vehicle 1/2', 'address 2/3']);
	expect(found.total).toBe(8);
	expect(found.groups.at(-1)!.hits[0]).toMatchObject({
		kind: 'address',
		label: 'Hub Street',
		lat: 45,
	});
	expect(withAddresses(found, [])).toEqual(list);
});

it('asks the geocoder only for text that can name a place', () => {
	expect(['ab', '  abc'.slice(0, 3), '45.5, -73.6', '45.5 -73'].map(canSearchAddresses)).toEqual([
		false,
		false,
		false,
		false,
	]);
	expect(['abc', 'Casgrain', '5333 casgrain'].map(canSearchAddresses)).toEqual([true, true, true]);
});

it('marks the first row exact only when it matches the query exactly', () => {
	const exact = (query: string, scope: 'all' | 'stop') => {
		const list = searchTransit({ surface: 'list', query, scope }, hubs(12));
		return [list.exact, list.groups[0]?.hits[0]?.id];
	};
	expect(exact('7', 'all')).toEqual([true, 'r7']);
	expect(exact('c7', 'stop')).toEqual([true, 's7']);
	expect(exact('hu', 'all')).toEqual([false, 'r0']);
	expect(exact('1', 'stop')).toEqual([false, 's1']);
});

it('waits for both indexes before an empty answer is final', () => {
	const { routes, stops } = hubs(2);
	expect(searchTransit({ surface: 'list', query: 'zz' }, { routes, stops: null })).toMatchObject({
		groups: [],
		total: 0,
		pending: true,
	});
	expect(searchTransit({ surface: 'list', query: 'zz' }, { routes, stops }).pending).toBe(false);
	const missing = (sources: SearchSources) =>
		searchTransit({ surface: 'list', query: 'zz' }, sources).unsearched;
	expect([
		missing({ routes, stops: null }),
		missing({ routes: null, stops: [] }),
		missing({ routes, stops: [] }),
	]).toEqual([['stop'], ['route'], []]);
});

it('labels rows with the names riders read', () => {
	const list = searchTransit(
		{ surface: 'list', query: '161' },
		{
			routes: [{ id: '161', short: '161', long: 'Van Horne', type: 3 }],
			stops: [{ id: 's', code: '161', name: 'MONTGOMERY / SHERBROOKE', lat: 0, lon: 0 }],
			vehicles: [{ ...vehicle('161'), route: '161' }],
		},
	);
	expect(list.groups.map((group) => group.hits[0])).toEqual([
		{ kind: 'route', id: '161', label: '161 · Van Horne' },
		{ kind: 'stop', id: 's', label: 'Montgomery / Sherbrooke', code: '161' },
		{ kind: 'vehicle', id: '161', label: '161', line: '161' },
	]);
});
