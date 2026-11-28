import { directionLabel } from '#lib/site/presenter.ts';
import { render, waitFor } from '@testing-library/svelte';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createRawSnippet } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { getMapRoutes } from '#lib/v1/repositories/scheduleShapes.ts';
import { getRoute } from '#lib/v1/repositories/static.ts';
import { RouteFileSchema } from '#lib/v1/schemas/route.ts';
import { attachRecordMap } from './recordMapLayers';
import MapRecordPanel from './MapRecordPanel.svelte';

vi.mock('#lib/v1/boot.ts', () => ({ getV1Context: () => ({ provider: null }) }));
vi.mock('#lib/site/transitDisplayContext.ts', () => ({
	transitDisplay: () => ({ lineName: (id: string) => ({ label: id }), directionLabel }),
}));
vi.mock('#lib/v1/repositories/static.ts', () => ({ getRoute: vi.fn() }));
vi.mock('#lib/v1/repositories/scheduleShapes.ts', () => ({ getMapRoutes: vi.fn() }));
vi.mock('./recordMapLayers', () => ({ attachRecordMap: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

it('draws a line answer before shapes arrive and uses straight segments for unavailable or network geometry', async () => {
	const stops = [
		{ id: 'a', name: 'Alpha', lon: -73.6, lat: 45.5 },
		{ id: 'b', name: 'Bravo', lon: -73.59, lat: 45.5 },
	];
	const straight = stops.map(({ lon, lat }) => [lon, lat]);
	const bend = [-73.595, 45.501];
	const direction = {
		dir: 0,
		headsign: 'Bravo',
		stops: [
			{ id: 'a', seq: 1 },
			{ id: 'b', seq: 2 },
		],
	};
	const route = RouteFileSchema.parse({
		id: 'L1',
		generated_utc: '2026-11-23T00:00:00Z',
		directions: [direction],
	});
	const shaped = {
		...route,
		directions: [
			{
				...direction,
				shape: { type: 'LineString', coordinates: [straight[0], bend, straight[1]] },
			},
		],
	};
	const loadShapes = vi.mocked(getMapRoutes);
	let supplyShape!: (routes: [typeof shaped]) => void;
	loadShapes.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				supplyShape = resolve;
			}),
	);
	loadShapes.mockRejectedValueOnce(new Error('Schedule map unavailable'));
	vi.mocked(getRoute).mockImplementation(async (id) => ({ ...route, id }));
	const fetch = vi.fn(async (url: string) => {
		const line = new URL(url, 'https://transit.example').searchParams.get('line');
		return Response.json({
			measure: 'mean_time_lost',
			...(line ? { direction: [0] } : {}),
			from_stop: ['a'],
			to_stop: ['b'],
			state: [3],
			sample: [25],
			value: [8],
			evidence: { days_not_measured: [] },
		});
	});
	vi.stubGlobal('fetch', fetch);
	const map = {
		getContainer: () => document.createElement('div'),
		fitBounds: vi.fn(),
	} as unknown as MapLibreMap;
	const { rerender } = render(MapRecordPanel, {
		props: {
			map,
			layer: 'corridors',
			line: '',
			direction: '',
			city: 'demo',
			period: { from: '2026-11-23', to: '2026-11-23', preset: null },
			url: new URL('https://transit.example/map'),
			locale: 'en',
			stops,
			terminals: new Set<string>(),
			routes: [],
			children: createRawSnippet(() => ({ render: () => '<div></div>' })),
			onlinefilters: vi.fn(),
			onsourcedate: vi.fn(),
		},
	});
	const draw = vi.mocked(attachRecordMap);
	const drawn = () => draw.mock.lastCall?.[1].features.find((f) => f.properties.state === 3);
	await waitFor(() => expect(drawn()?.geometry.coordinates).toEqual(straight));
	expect(draw.mock.lastCall?.[3]).toBe(true);
	expect(loadShapes).not.toHaveBeenCalled();

	await rerender({ line: 'L1' });
	await waitFor(() => expect(draw.mock.lastCall?.[3]).toBe(false));
	expect(loadShapes).toHaveBeenCalledExactlyOnceWith(
		['L1'],
		expect.objectContaining({ providerId: 'demo' }),
	);
	expect(drawn()?.geometry.coordinates).toEqual(straight);
	supplyShape([shaped]);
	await waitFor(() => expect(drawn()?.geometry.coordinates).toContainEqual(bend));

	await rerender({ line: 'L2' });
	await waitFor(() => {
		expect(loadShapes).toHaveBeenLastCalledWith(['L2'], expect.anything());
		expect(drawn()?.geometry.coordinates).toEqual(straight);
	});
});
