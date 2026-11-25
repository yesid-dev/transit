import { expect, it, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));
import {
	canSearchAddresses,
	searchTransit,
	withAddresses,
	type SearchKind,
	type SearchList,
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
const hits = (list: SearchList, kind: SearchKind) =>
	list.groups.find((group) => group.kind === kind)?.hits ?? [];

it('keeps a line with an unknown mode and leaves its mode unspecified', () => {
	const query = 'hub';
	const sources = { routes: [{ id: 'unknown', short: '?', long: 'Hub', type: 999 }] };
	expect(hits(searchTransit({ query }, sources), 'route')).toMatchObject([
		{ id: 'unknown', mode: null },
	]);
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
	const found = hits(searchTransit({ query }, { stops }), 'stop');
	expect(resultIds(found)).toEqual([id]);
	expect(found[0]?.label).toBe(label);
});

it('accepts absent sources without inventing results', () => {
	for (const sources of [{}, { routes: null, stops: null, vehicles: null, pages: null }]) {
		for (const [query, folded] of [
			['hub', 'hub'],
			['', ''],
			['   ', ''],
			['---', ''],
		]) {
			expect(searchTransit({ query }, sources)).toMatchObject({
				query: folded,
				groups: [],
				total: 0,
			});
		}
	}
});

it('finds a line or a stop by what riders read first, and an internal id only exactly', () => {
	const stops: StopIndexEntry[] = [
		{ id: '95', code: '3033', name: 'Pleasant Hill', lat: 0, lon: 0 },
		{ id: 'x1', code: '9512', name: 'Elm', lat: 0, lon: 0 },
	];
	const routes = [{ id: 'r9', short: '9', long: 'Hub', type: 3 }];
	for (const [query, stopIds, routeIds] of [
		['95', ['x1', '95'], []],
		['9', ['x1'], ['r9']],
		['3033', ['95'], []],
		['r9', [], ['r9']],
		['r', [], []],
	] as const) {
		const list = searchTransit({ query }, { stops, routes });
		expect([resultIds(hits(list, 'stop')), resultIds(hits(list, 'route'))]).toEqual([
			stopIds,
			routeIds,
		]);
	}
});

it('finds pages by their names in either language and by the terms they explain', () => {
	const pages = [
		{
			href: '/receipt',
			label: { en: 'Daily report', fr: 'Rapport quotidien' },
			words: ['Missing trip', 'Trajet manquant'],
		},
		{
			href: '/metrics',
			label: { en: 'How we measure', fr: 'Comment on mesure' },
			words: ['On time', 'À l’heure'],
		},
	];
	for (const [query, hrefs] of [
		['rapport', ['/receipt']],
		['daily report', ['/receipt']],
		['a l heure', ['/metrics']],
		['missing trip', ['/receipt']],
		['zzz', []],
	] as const) {
		expect(resultIds(hits(searchTransit({ query }, { pages }), 'page'))).toEqual(hrefs);
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
	const list = searchTransit({ query: 'hub' }, sources);
	expect(list.groups.map((group) => group.hits[0]?.id)).toEqual(['r', 's', 'hub']);
	expect(JSON.stringify(sources)).toBe(before);
});

it('can reveal a larger page without changing the total', () => {
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
	const list = searchTransit({ query: 'hub', rows: 51 }, { routes, stops });
	expect(shape(list)).toEqual(['route 51/51', 'stop 51/51']);
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
	expect(resultIds(hits(searchTransit({ query: 'café' }, { routes }), 'route'))).toEqual([
		'z',
		'a',
	]);
	expect(resultIds(hits(searchTransit({ query: 'hub' }, { stops }), 'stop'))).toEqual(['z', 'a']);
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
		expect(resultIds(hits(searchTransit({ query }, { routes }), 'route'))).toEqual(ids);
	}
	for (const query of ['400', '40061']) {
		const ids = query === '40061' ? ['40061'] : [];
		expect(resultIds(hits(searchTransit({ query }, { vehicles }), 'vehicle'))).toEqual(ids);
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
	const list = searchTransit({ query: 'hu' }, hubs(38));
	expect(shape(list)).toEqual(['route 4/38', 'stop 4/38']);
	expect(list.total).toBe(76);
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
		{ query: 'hub' },
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
	const exact = (query: string) => {
		const list = searchTransit({ query }, hubs(12));
		return [list.exact, list.groups[0]?.hits[0]?.id];
	};
	expect(exact('7')).toEqual([true, 'r7']);
	expect(exact('c7')).toEqual([true, 's7']);
	expect(exact('hu')).toEqual([false, 'r0']);
	expect(exact('1')).toEqual([true, 'r1']);
});

it('waits for both indexes before an empty answer is final', () => {
	const { routes, stops } = hubs(2);
	expect(searchTransit({ query: 'zz' }, { routes, stops: null })).toMatchObject({
		groups: [],
		total: 0,
		pending: true,
	});
	expect(searchTransit({ query: 'zz' }, { routes, stops }).pending).toBe(false);
	const missing = (sources: SearchSources) => searchTransit({ query: 'zz' }, sources).unsearched;
	expect([
		missing({ routes, stops: null }),
		missing({ routes: null, stops: [] }),
		missing({ routes, stops: [] }),
	]).toEqual([['stop'], ['route'], []]);
});

it('labels rows with the names riders read', () => {
	const list = searchTransit(
		{ query: '161' },
		{
			routes: [{ id: '161', short: '161', long: 'Van Horne', type: 3 }],
			stops: [{ id: 's', code: '161', name: 'MONTGOMERY / SHERBROOKE', lat: 0, lon: 0 }],
			vehicles: [{ ...vehicle('161'), route: '161' }],
		},
	);
	expect(list.groups.map((group) => group.hits[0])).toMatchObject([
		{ kind: 'route', id: '161', label: '161 · Van Horne' },
		{ kind: 'stop', id: 's', label: 'Montgomery / Sherbrooke', code: '161' },
		{ kind: 'vehicle', id: '161', label: '161', line: '161' },
	]);
});
it('includes bilingual app pages in the same ranked list on both surfaces', () => {
	const pages = [
		{
			href: '/metrics',
			label: { en: 'How we measure', fr: 'Comment on mesure' },
			words: [],
		},
	];
	for (const rows of [undefined, 6]) {
		const { groups, total } = searchTransit(
			{ query: 'comment on mesure', rows },
			{ routes: [], stops: [], vehicles: [], pages, locale: 'en' },
		);
		expect(total).toBe(1);
		expect(groups[0]?.hits[0]).toMatchObject({
			kind: 'page',
			id: '/metrics',
			label: 'How we measure',
		});
	}
});
