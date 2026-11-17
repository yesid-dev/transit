import { describe, expect, it } from 'vitest';
import { emptyFilterState, fromSearchParams } from '#lib/filters/index.ts';
import { buildMapReportLiveViewHref } from './mapReportsLink';
import {
	MAP_VIEW_MAX_PITCH,
	MAP_VIEW_MAX_ZOOM,
	MAP_VIEW_MIN_ZOOM,
	MAP_VIEW_PARAM,
	parseMapViewHint,
	mapViewHintWithinRuntime,
	serializeMapViewHint,
	setMapViewHint,
} from './mapViewHint';

const BOUNDS = [-74.2, 45.2, -73.2, 45.9] as const;

function params(value: string): URLSearchParams {
	return new URLSearchParams(`${MAP_VIEW_PARAM}=${encodeURIComponent(value)}`);
}

describe('map view hint', () => {
	it('preserves an actual provider-fit camera below zoom nine without precision loss', () => {
		const camera = {
			center: [-73.600000000123, 45.500000000456] as const,
			zoom: 8.123456789,
			bearing: 12.3456789,
			pitch: 23.456789,
		};
		expect(parseMapViewHint(params(serializeMapViewHint(camera)), BOUNDS)).toEqual(camera);
	});

	it('checks the receiving map limits before applying a parsed camera', () => {
		const camera = { center: [-73.6, 45.5] as const, zoom: 8.123456789, bearing: 0, pitch: 20 };
		const limits = {
			getMinZoom: () => 8.1,
			getMaxZoom: () => 16,
			getMinPitch: () => 0,
			getMaxPitch: () => 60,
		};
		expect(mapViewHintWithinRuntime(camera, limits)).toBe(true);
		expect(mapViewHintWithinRuntime(camera, { ...limits, getMinZoom: () => 9 })).toBe(false);
		expect(mapViewHintWithinRuntime(camera, { ...limits, getMaxPitch: () => 10 })).toBe(false);
		expect(mapViewHintWithinRuntime(camera, { ...limits, getMinZoom: () => NaN })).toBe(false);
	});

	it('round-trips one actual camera', () => {
		const hint = { center: [-73.6, 45.5] as const, zoom: 12.5, bearing: -33.3, pitch: 20 };
		const parsed = parseMapViewHint(params(serializeMapViewHint(hint)), BOUNDS);
		expect(parsed).toEqual(hint);
	});

	it('ignores duplicates and malformed values without throwing', () => {
		expect(
			parseMapViewHint(
				new URLSearchParams(
					`${MAP_VIEW_PARAM}=-73.6,45.5,12,0,0&${MAP_VIEW_PARAM}=-73.6,45.5,12,0,0`,
				),
				BOUNDS,
			),
		).toBeNull();
		for (const value of [
			'',
			'-73.6,45.5,12,0',
			'-73.6,45.5,12,0,0,0',
			'-73.6,45.5,12,0,x',
			'NaN,45.5,12,0,0',
			'Infinity,45.5,12,0,0',
			'-73.6,45.5,12,0,0 ',
			'-73.6,45.5,12,0,0\n',
			'1e2,45.5,12,0,0',
		]) {
			expect(parseMapViewHint(params(value), BOUNDS)).toBeNull();
		}
	});

	it('rejects positions outside the published area and cameras beyond the runtime limits', () => {
		expect(parseMapViewHint(params('-70,45.5,12,0,0'), BOUNDS)).toBeNull();
		expect(parseMapViewHint(params('-73.6,40,12,0,0'), BOUNDS)).toBeNull();
		expect(
			parseMapViewHint(params(`-73.6,45.5,${MAP_VIEW_MIN_ZOOM - 0.01},0,0`), BOUNDS),
		).toBeNull();
		expect(
			parseMapViewHint(params(`-73.6,45.5,${MAP_VIEW_MAX_ZOOM + 0.01},0,0`), BOUNDS),
		).toBeNull();
		expect(parseMapViewHint(params('-73.6,45.5,12,181,0'), BOUNDS)).toBeNull();
		expect(
			parseMapViewHint(params(`-73.6,45.5,12,0,${MAP_VIEW_MAX_PITCH + 1}`), BOUNDS),
		).toBeNull();
		expect(
			parseMapViewHint(params(`-73.6,45.5,${MAP_VIEW_MIN_ZOOM},-180,0`), BOUNDS),
		).not.toBeNull();
		expect(
			parseMapViewHint(params(`-73.6,45.5,${MAP_VIEW_MAX_ZOOM},180,${MAP_VIEW_MAX_PITCH}`), BOUNDS),
		).not.toBeNull();
	});

	it('writes one value and keeps unrelated parameters', () => {
		const next = new URLSearchParams(`${MAP_VIEW_PARAM}=stale&provider=stm&route=24`);
		setMapViewHint(next, { center: [-73.6, 45.5], zoom: 12, bearing: 0, pitch: 0 });
		expect(next.getAll(MAP_VIEW_PARAM)).toEqual(['-73.6,45.5,12,0,0']);
		expect(next.get('provider')).toBe('stm');
	});
});

describe('copied live view link', () => {
	const camera = { center: [-73.6, 45.5] as const, zoom: 12, bearing: 0, pitch: 0 };

	it('carries the provider, locale path, live filters and camera hint', () => {
		const href = buildMapReportLiveViewHref(
			new URL(
				'http://localhost/fr/map?provider=stm&route=99&focus=vehicle:bus-1&near=45.5,-73.6&nearLabel=Home',
			),
			fromSearchParams(new URLSearchParams('route=24&status=late&out_of_service=1')),
			camera,
			'stm',
		)!;
		const url = new URL(href);
		expect(url.origin).toBe('http://localhost');
		expect(url.pathname).toBe('/fr/map');
		expect(url.searchParams.get('provider')).toBe('stm');
		expect(url.searchParams.getAll('route')).toEqual(['24']);
		expect(url.searchParams.get('status')).toBe('late');
		expect(url.searchParams.get('out_of_service')).toBe('1');
		expect(url.searchParams.has('focus')).toBe(false);
		expect(url.searchParams.has('near')).toBe(false);
		expect(url.searchParams.getAll(MAP_VIEW_PARAM)).toEqual(['-73.6,45.5,12,0,0']);
	});

	it('clears record periods and old-live hints', () => {
		const base = new URL(
			'http://localhost/map?provider=stm&from=2026-01-01&to=2026-01-02&grain=day&date=2026-01-03&n=10&generation=old&published=2026-01-01T00:00:00Z&method=old&edition=old',
		);
		const url = new URL(
			buildMapReportLiveViewHref(base, fromSearchParams(base.searchParams), camera, 'stm')!,
		);
		for (const key of [
			'from',
			'to',
			'grain',
			'date',
			'n',
			'generation',
			'published',
			'method',
			'edition',
		]) {
			expect(url.searchParams.has(key)).toBe(false);
		}
	});

	it('restores opaque live IDs containing a comma without turning one ID into multiple restrictions', () => {
		const filter = emptyFilterState();
		filter.routes.add('line,branch');
		filter.routes.add('literal%2C');
		filter.stops.add('stop,platform');
		const href = buildMapReportLiveViewHref(
			new URL('http://localhost/map'),
			filter,
			camera,
			'stm',
		)!;
		const restored = fromSearchParams(new URL(href).searchParams);
		expect([...restored.routes].sort()).toEqual([...filter.routes].sort());
		expect([...restored.stops]).toEqual([...filter.stops]);
	});

	it('is unavailable without a captured camera', () => {
		expect(
			buildMapReportLiveViewHref(new URL('http://localhost/map'), emptyFilterState(), null, 'stm'),
		).toBeNull();
	});

	it('round-trips through parsing before the map is ready', () => {
		const href = buildMapReportLiveViewHref(
			new URL('http://localhost/map?provider=stm'),
			fromSearchParams(new URLSearchParams('route=24')),
			{ center: [-73.65, 45.49], zoom: 13, bearing: 15, pitch: 30 },
			'stm',
		)!;
		expect(parseMapViewHint(new URL(href).searchParams, BOUNDS)).toEqual({
			center: [-73.65, 45.49],
			zoom: 13,
			bearing: 15,
			pitch: 30,
		});
		expect([...fromSearchParams(new URL(href).searchParams).routes]).toEqual(['24']);
	});
});
