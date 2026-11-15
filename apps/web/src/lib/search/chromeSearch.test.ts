import { describe, expect, it, vi } from 'vitest';
import type { RouteIndexEntry, StopIndexEntry, Vehicle } from '#lib/v1/schemas/index.ts';

vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));

import {
	searchTransit,
	type SearchSources,
	type SearchHit,
	chromeSearchHref,
	searchHitHref,
	scopeForPath,
} from './transitSearch';
import type { TransitModeKey } from './stopMode';

// What the search engine matches, read on the page surface: lines, then stops, then vehicles.
function matches(query: string, sources: SearchSources, modes?: ReadonlySet<TransitModeKey>) {
	const page = searchTransit({ surface: 'page', query, modes }, sources);
	return [
		...page.routes.map(({ id }) => ({ kind: 'route', id })),
		...page.stops.map(({ id }) => ({ kind: 'stop', id })),
		...page.vehicles.map(({ id }) => ({ kind: 'vehicle', id })),
	];
}

const routes: RouteIndexEntry[] = [
	{ id: '24', short: '24', long: 'Sherbrooke', type: 3 },
	{ id: '161', short: '161', long: 'Van Horne', type: 3 },
	{ id: '1', short: '1', long: 'Ligne 1 - Verte', type: 1 },
];

const stops: StopIndexEntry[] = [
	{ id: '52819', code: '52618', name: 'Montgomery / Sherbrooke', lat: 45.52, lon: -73.55 },
	{ id: '51243', code: '51243', name: 'Station Villa-Maria', lat: 45.48, lon: -73.62 },
	{ id: '57191', code: '57191', name: 'Van Horne / Rockland', lat: 45.53, lon: -73.59 },
];

const updatedUtc = '2026-06-16T00:00:00Z' as Vehicle['updated_utc'];

const vehicles: Vehicle[] = [
	{
		id: '40061',
		lat: 45.5,
		lon: -73.6,
		status: 'late',
		updated_utc: updatedUtc,
		route: '161',
		trip: '296851600',
		next_stop: '57191',
	},
	{
		id: '161',
		lat: 45.51,
		lon: -73.61,
		status: 'on_time',
		updated_utc: updatedUtc,
		route: '24',
	},
];

describe('matching', () => {
	it('matches stop names and rider-facing stop codes', () => {
		expect(matches('villa', { routes, stops, vehicles })[0]).toEqual({ kind: 'stop', id: '51243' });
		expect(matches('52618', { routes, stops, vehicles })[0]).toEqual({ kind: 'stop', id: '52819' });
	});

	it('only returns vehicles on exact id matches', () => {
		expect(matches('400', { routes, stops, vehicles }).some((r) => r.kind === 'vehicle')).toBe(
			false,
		);
		expect(matches('40061', { routes, stops, vehicles })).toEqual([
			{ kind: 'vehicle', id: '40061' },
		]);
	});

	it('finds métro stations and accented names the way riders type them', () => {
		const metro: StopIndexEntry[] = [
			{ id: '10146', code: '10146', name: 'Station Berri-UQAM', lat: 45.51, lon: -73.56 },
			{ id: '11000', code: '11000', name: 'Station Crémazie', lat: 45.55, lon: -73.62 },
		];

		expect(matches('berri uqam', { stops: metro })[0]).toMatchObject({
			kind: 'stop',
			id: '10146',
		});
		expect(matches('uqam berri', { stops: metro })[0]).toMatchObject({
			kind: 'stop',
			id: '10146',
		});
		expect(matches('cremazie', { stops: metro })[0]).toMatchObject({
			kind: 'stop',
			id: '11000',
		});
	});

	it('collapses the métro interchange duplicate platforms (shared code) to one result', () => {
		const platforms: StopIndexEntry[] = [
			{ id: '9999111', code: '10146', name: 'Station Berri-UQAM', lat: 45.51, lon: -73.56 },
			{ id: '9999112', code: '10146', name: 'Station Berri-UQAM', lat: 45.51, lon: -73.56 },
			{ id: '9999114', code: '10146', name: 'Station Berri-UQAM', lat: 45.51, lon: -73.56 },
		];

		const results = matches('berri uqam', { stops: platforms });
		const stops = results.filter((r) => r.kind === 'stop');
		expect(stops).toHaveLength(1);
		expect(stops[0]?.id).toBe('9999111');
	});

	it('keeps a station name without a published mode as separate stops (different codes)', () => {
		const station: StopIndexEntry[] = [
			{ id: '1', code: '10280', name: 'Station Henri-Bourassa', lat: 45.554, lon: -73.668 },
			{ id: '50301', code: '50301', name: 'Station Henri-Bourassa', lat: 45.554, lon: -73.669 },
			{ id: '50303', code: '50303', name: 'Station Henri-Bourassa', lat: 45.554, lon: -73.668 },
		];

		const stops = matches('henri bourassa', { stops: station }).filter((r) => r.kind === 'stop');
		expect(stops.map((r) => r.id)).toEqual(['1', '50301', '50303']);
	});

	it('keeps two distinct same-named non-station stops separate', () => {
		const twins: StopIndexEntry[] = [
			{ id: '100', code: '100', name: 'Parc / Laurier', lat: 45.52, lon: -73.6 },
			{ id: '200', code: '200', name: 'Parc / Laurier', lat: 45.521, lon: -73.601 },
		];
		const stops = matches('parc laurier', { stops: twins }).filter((r) => r.kind === 'stop');
		expect(stops).toHaveLength(2);
	});

	it('matches an intersection stop with the cross streets in either order', () => {
		const intersection: StopIndexEntry[] = [
			{ id: '52819', code: '52618', name: 'Montgomery / Sherbrooke', lat: 45.52, lon: -73.55 },
		];

		expect(matches('sherbrooke montgomery', { stops: intersection })[0]).toMatchObject({
			kind: 'stop',
			id: '52819',
		});
	});
});

describe('chromeSearchHref', () => {
	it('routes every selected result into the map filter spine', () => {
		expect(chromeSearchHref({ kind: 'route', id: '161' })).toBe('/map?route=161&focus=route%3A161');
		expect(chromeSearchHref({ kind: 'stop', id: '52819' })).toBe(
			'/map?stop=52819&focus=stop%3A52819',
		);
		expect(chromeSearchHref({ kind: 'vehicle', id: '40061' })).toBe(
			'/map?vehicle=40061&focus=vehicle%3A40061',
		);
	});

	it('stacks selected results onto the existing map filter query', () => {
		const current = new URLSearchParams('vehicle=40061&status=late&stop=53355');

		expect(chromeSearchHref({ kind: 'vehicle', id: '40062' }, current)).toBe(
			'/map?stop=53355&vehicle=40061%2C40062&status=late&focus=vehicle%3A40062',
		);
		expect(chromeSearchHref({ kind: 'stop', id: '53355' }, current)).toBe(
			'/map?stop=53355&vehicle=40061&status=late&focus=stop%3A53355',
		);
		expect(chromeSearchHref({ kind: 'route', id: '161' }, current)).toBe(
			'/map?route=161&stop=53355&vehicle=40061&status=late&focus=route%3A161',
		);
	});

	it('routes address results to the map near target while preserving existing filters', () => {
		const current = new URLSearchParams('route=161&status=late');

		expect(
			chromeSearchHref(
				{
					kind: 'address',
					id: '45.525686,-73.594764',
					label: '5333 Avenue Casgrain, Montréal, Quebec',
					lat: 45.5256864,
					lon: -73.5947644,
				},
				current,
			),
		).toBe(
			'/map?route=161&status=late&near=45.525686%2C-73.594764&nearLabel=5333+Avenue+Casgrain%2C+Montr%C3%A9al%2C+Quebec',
		);
	});

	it('preserves an active address target when stacking route, stop, or bus filters', () => {
		const current = new URLSearchParams('near=45.525686,-73.594764&nearLabel=Mile End');

		expect(chromeSearchHref({ kind: 'route', id: '161' }, current)).toBe(
			'/map?route=161&near=45.525686%2C-73.594764&nearLabel=Mile+End&focus=route%3A161',
		);
	});

	it('preserves every non-filter occurrence verbatim when invoked from map scope', () => {
		const current = new URLSearchParams(
			'x=1&route=24&x=&near=45.5000000%2C-73.5000000&empty=&status=late&x=2',
		);

		expect(chromeSearchHref({ kind: 'route', id: '161' }, current, 'map')).toBe(
			'/map?x=1&x=&near=45.5000000%2C-73.5000000&empty=&x=2&route=161%2C24&status=late&focus=route%3A161',
		);
	});
});

describe('scopeForPath', () => {
	it('maps the line catalogue and route detail to route scope', () => {
		expect(scopeForPath('/lines')).toBe('route');
		expect(scopeForPath('/lines/161')).toBe('route');
	});

	it('maps the stop catalogue and stop detail to stop scope', () => {
		expect(scopeForPath('/stops')).toBe('stop');
		expect(scopeForPath('/stop/52819')).toBe('stop');
	});

	it('maps the map surface to map scope', () => {
		expect(scopeForPath('/map')).toBe('map');
	});

	it('falls back to the full blend on the hub, network, and search surfaces', () => {
		expect(scopeForPath('/')).toBe('all');
		expect(scopeForPath('/network')).toBe('all');
		expect(scopeForPath('/search')).toBe('all');
	});
});

describe('searchHitHref', () => {
	const routeResult: SearchHit = {
		kind: 'route',
		id: '161',
		label: '161 Van Horne',
	};
	const stopResult: SearchHit = {
		kind: 'stop',
		id: '52819',
		label: 'Montgomery / Sherbrooke',
	};
	const from = (path: string, query = '') => ({ path, params: new URLSearchParams(query) });

	it('opens a line or a stop on its own page from every page but the map', () => {
		for (const path of ['/', '/network', '/lines', '/stops', '/search', '/trip/9']) {
			expect(searchHitHref(routeResult, from(path, 'route=24&x=1'))).toBe('/lines/161');
			expect(searchHitHref(stopResult, from(path, 'route=24&x=1'))).toBe('/stop/52819');
		}
	});

	it('keeps map focus for a line or a stop chosen on the map', () => {
		expect(searchHitHref(routeResult, from('/map'))).toBe('/map?route=161&focus=route%3A161');
		expect(searchHitHref(stopResult, from('/map', 'x=1'))).toBe(
			'/map?x=1&stop=52819&focus=stop%3A52819',
		);
	});

	it('opens another line on the same tab and period, on line pages only', () => {
		const view = 'tab=reliability&grain=range&from=2026-11-01&to=2026-11-07&route=17&x=1';
		expect(searchHitHref(routeResult, from('/lines/17', view))).toBe(
			'/lines/161?tab=reliability&grain=range&from=2026-11-01&to=2026-11-07',
		);
		expect(searchHitHref(routeResult, from('/lines', view))).toBe('/lines/161');
		expect(searchHitHref(routeResult, from('/stop/52819', view))).toBe('/lines/161');
	});

	it('opens another stop on the same tab and period, on stop pages only', () => {
		const view = 'grain=month&tab=schedule';
		expect(searchHitHref(stopResult, from('/stop/1', view))).toBe(
			'/stop/52819?tab=schedule&grain=month',
		);
		expect(searchHitHref(stopResult, from('/lines/17', view))).toBe('/stop/52819');
	});

	it('opens a live vehicle on the map, dropping foreign params, from any other page', () => {
		const current = 'x=1&x=&route=24&near=45.5000000%2C-73.5000000&nearLabel=Raw';
		const vehicle: SearchHit = {
			kind: 'vehicle',
			id: '40061',
			label: '40061',
		};

		expect(searchHitHref(vehicle, from('/lines/24', current))).toBe(
			'/map?route=24&vehicle=40061&near=45.500000%2C-73.500000&nearLabel=Raw&focus=vehicle%3A40061',
		);
	});

	it('falls through to the map near target for an address (no detail route)', () => {
		const address: SearchHit = {
			kind: 'address',
			id: '45.525686,-73.594764',
			label: '5333 Avenue Casgrain, Montréal, Quebec',
			lat: 45.5256864,
			lon: -73.5947644,
		};

		expect(searchHitHref(address, from('/'))).toBe(
			'/map?near=45.525686%2C-73.594764&nearLabel=5333+Avenue+Casgrain%2C+Montr%C3%A9al%2C+Quebec',
		);
	});

	it('URI-encodes the entity id through routeFor', () => {
		expect(searchHitHref({ ...routeResult, id: '10 A' }, from('/lines'))).toBe('/lines/10%20A');
	});
});

describe('mode filter', () => {
	it('keeps every family when no mode is selected', () => {
		const results = matches('van horne', { routes, stops, vehicles }, new Set());
		expect(results.some((r) => r.kind === 'route' && r.id === '161')).toBe(true);
		expect(results.some((r) => r.kind === 'stop' && r.id === '57191')).toBe(true);
	});

	it('narrows lines and stops to the selected transit modes', () => {
		const busOnly = matches('van horne', { routes, stops, vehicles }, new Set(['bus' as const]));
		expect(busOnly.some((r) => r.kind === 'route' && r.id === '161')).toBe(true);

		const metroOnly = matches(
			'van horne',
			{ routes, stops, vehicles },
			new Set(['metro' as const]),
		);
		expect(metroOnly).toEqual([]);

		const metroLine = matches('ligne 1', { routes }, new Set(['metro' as const]));
		expect(metroLine.map((r) => r.id)).toContain('1');
	});

	it('drops buses that the selected modes exclude', () => {
		const metro = matches('40061', { routes, stops, vehicles }, new Set(['metro' as const]));
		expect(metro.some((r) => r.kind === 'vehicle')).toBe(false);

		const bus = matches('40061', { vehicles }, new Set(['bus' as const]));
		expect(bus.map((r) => r.id)).toContain('40061');
	});
});
