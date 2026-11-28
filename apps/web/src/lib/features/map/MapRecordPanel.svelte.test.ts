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
import MapRecordPanelHarness from './__fixtures__/MapRecordPanelHarness.svelte';

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
			routes: [],
			children: createRawSnippet(() => ({ render: () => '<div></div>' })),
			onlinefilters: vi.fn(),
			onsourcedate: vi.fn(),
		},
	});
	const draw = vi.mocked(attachRecordMap);
	const drawn = () => draw.mock.lastCall?.[1].features.find((f) => f.properties.state === 3);
	await waitFor(() => expect(drawn()?.geometry.coordinates).toEqual(straight));
	expect(draw.mock.lastCall?.[3]).toMatchObject({ network: true, waits: false });
	expect(loadShapes).not.toHaveBeenCalled();

	await rerender({ line: 'L1' });
	await waitFor(() =>
		expect(draw.mock.lastCall?.[3]).toMatchObject({ network: false, waits: false }),
	);
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

const camera = {
	center: [-73.6, 45.5] as [number, number],
	zoom: 10,
	bearing: 0,
	pitch: 0,
	width: 1000,
	height: 1000,
	bbox: { west: -74, south: 45, east: -73, north: 46 },
	project: () => ({ x: 500, y: 500 }),
};
const panelProps = {
	map: { getContainer: () => document.createElement('div'), fitBounds: vi.fn() },
	line: '',
	direction: '',
	city: 'demo',
	period: { from: '2026-11-23', to: '2026-11-23', preset: null },
	url: new URL('https://transit.example/map'),
	routes: [],
	reportCamera: camera,
	onlinefilters: vi.fn(),
	onsourcedate: vi.fn(),
};
const columns = (n: number, value: (i: number) => unknown) =>
	Array.from({ length: n }, (_, i) => value(i));

function answerWith(body: unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) =>
			url.startsWith('/api/corridor-map')
				? new Response(null, { status: 404 })
				: Response.json(body),
		),
	);
}

for (const locale of ['en', 'fr'] as const) {
	it(`answers Waits with its worst reading in view and colours only the worst at network zoom (${locale})`, async () => {
		const stops = columns(301, (i) => ({ id: `s${i}`, name: `Stop ${i}`, lon: -73.6, lat: 45.5 }));
		answerWith({
			measure: 'excess_wait_time',
			minimum_sample: 20,
			line: columns(301, () => '24'),
			direction: columns(301, () => 0),
			stop: columns(301, (i) => `s${i}`),
			value: columns(301, (i) => i + 1),
			sample: columns(301, () => 40),
			state: columns(301, () => 'measured'),
			low_coverage: columns(301, () => false),
			evidence: { days_not_measured: [] },
		});
		const oncap = vi.fn();
		const oncount = vi.fn();
		const { container, getByTestId } = render(MapRecordPanelHarness, {
			props: { ...panelProps, layer: 'waits', locale, stops, oncap, oncount } as never,
		});
		const fr = locale === 'fr';
		await waitFor(() =>
			expect(getByTestId('record-headline')).toHaveTextContent(fr ? '5,0 min' : '5.0 min'),
		);
		expect(container.querySelector('[data-slot="screen-answer"]')?.textContent).toContain(
			fr
				? 'est la plus longue attente en plus en vue : ligne 24 à Stop 300.'
				: 'is the longest extra wait in view: line 24 at Stop 300.',
		);
		expect(oncap).toHaveBeenLastCalledWith(300);
		expect(oncount).toHaveBeenLastCalledWith(301);
		expect(container.querySelector('[data-record-cap-note]')).toHaveTextContent(
			fr
				? 'La carte colore les 300 pires à ce zoom.'
				: 'The map colours the 300 worst at this zoom.',
		);
		const draw = vi.mocked(attachRecordMap).mock.lastCall!;
		expect(draw[1].features).toHaveLength(300);
		expect(draw[3].underlay?.features).toHaveLength(1);
		// The method follows the answer and the list, never before the figure.
		const method = container.querySelector('[data-record-method]')!;
		const list = container.querySelector('[data-slot="map-in-view"]')!;
		expect(list.compareDocumentPosition(method) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it(`answers Clear run with its stretch and lists a shared stretch without a plate (${locale})`, async () => {
		const stops = [
			{ id: 'a', name: 'Alpha', code: '61263', lon: -73.6, lat: 45.5 },
			{ id: 'b', name: 'Bravo', lon: -73.59, lat: 45.5 },
		];
		answerWith({
			measure: 'clear_run_time_lost',
			minimum_sample: 20,
			line: ['24'],
			direction: [0],
			from_stop: ['a'],
			to_stop: ['b'],
			clear_run_seconds: [120],
			median_run_seconds: [396],
			value: [276],
			sample: [30],
			state: ['measured'],
			low_coverage: [false],
			evidence: { days_not_measured: [] },
		});
		const fr = locale === 'fr';
		const clear = render(MapRecordPanelHarness, {
			props: { ...panelProps, layer: 'clear-run', locale, stops } as never,
		});
		await waitFor(() =>
			expect(clear.container.querySelector('[data-slot="screen-answer"]')?.textContent).toContain(
				fr
					? 'est le plus grand temps perdu par rapport à un parcours fluide en vue : ligne 24, de Alpha à Bravo.'
					: 'is the most time lost against a clear run in view: line 24, Alpha to Bravo.',
			),
		);
		clear.unmount();

		answerWith({
			measure: 'mean_time_lost',
			lines: [['24', '51']],
			from_stop: ['a'],
			to_stop: ['b'],
			state: [3],
			sample: [25],
			value: [240],
			evidence: { days_not_measured: [] },
		});
		const shared = render(MapRecordPanelHarness, {
			props: { ...panelProps, layer: 'corridors', locale, stops } as never,
		});
		const row = await waitFor(() => {
			const found = shared.container.querySelector('[data-map-panel-row]');
			expect(found).not.toBeNull();
			return found!;
		});
		expect(row.querySelector('[data-map-row-code]')).toBeEmptyDOMElement();
		expect(row.querySelector('a[data-map-row-name]')?.getAttribute('href')).toMatch(/\/stop\/a\?/u);
		expect(row.querySelector('small')).toHaveTextContent(fr ? 'à Bravo' : 'to Bravo');
	});
}
