import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { buildLiveIndex } from '#lib/v1/live/index.ts';
import type { IsoUtc, StopFile, StopIndexEntry } from '#lib/v1/schemas/index.ts';
import MapSelectionSummary from './MapSelectionSummary.svelte';
import { resolveMapSelection } from './selectionSession/mapSelection';

const utc = (value: string) => value as IsoUtc;

const stops: StopIndexEntry[] = [
	{ id: 'stop-1', name: 'Sherbrooke / Saint-Denis', code: '52618', lat: 45.51, lon: -73.57 },
];

const stopFiles: StopFile[] = [
	{
		generated_utc: utc('2026-06-15T00:00:00Z'),
		id: 'stop-1',
		name: 'Sherbrooke / Saint-Denis',
		lat: 45.51,
		lon: -73.57,
		code: '52618',
		routes_served: ['24'],
		scheduled: [{ route: '24', headsign: 'East', times: ['12:00'] }],
	},
];

describe('stop departures resilience', () => {
	it('keeps an unavailable departures source distinct from a successfully empty board', () => {
		const index = buildLiveIndex({ stopDepartures: null });
		const unavailable = resolveMapSelection(
			{ kind: 'stop', id: 'stop-1' },
			{ index, stops, stopFiles, departuresAvailable: false },
		);
		const empty = resolveMapSelection(
			{ kind: 'stop', id: 'stop-1' },
			{ index, stops, stopFiles, departuresAvailable: true },
		);

		if (unavailable?.kind !== 'stop' || empty?.kind !== 'stop') {
			throw new Error('expected stop details');
		}

		expect(unavailable.departures).toBeNull();
		expect(unavailable.routeTimes[0].liveDepartures).toBeNull();
		expect(empty.departures).toEqual([]);
		expect(empty.routeTimes[0].liveDepartures).toEqual([]);
	});

	it.each([
		['en', 'Next departures', 'No live data', 'No departure is predicted now.'],
		['fr', 'Prochains départs', 'Aucune donnée en direct', 'Aucun départ prévu en ce moment.'],
	] as const)(
		'renders distinct departure source states in %s',
		async (locale, heading, noLive, empty) => {
			const index = buildLiveIndex({ stopDepartures: null });
			const unavailable = resolveMapSelection(
				{ kind: 'stop', id: 'stop-1' },
				{ index, stops, stopFiles, departuresAvailable: false },
			);
			const answered = resolveMapSelection(
				{ kind: 'stop', id: 'stop-1' },
				{ index, stops, stopFiles, departuresAvailable: true },
			);
			if (unavailable?.kind !== 'stop' || answered?.kind !== 'stop') {
				throw new Error('expected stop details');
			}

			const view = render(MapSelectionSummary, {
				detail: unavailable,
				locale,
				url: new URL('https://transit.example/map'),
				city: 'stm',
				vehiclesInView: null,
			});
			expect(view.getByText(heading)).toBeVisible();
			expect(view.container.querySelector('[data-record-state="no_live_data"]')).toHaveTextContent(
				noLive,
			);
			expect(view.queryByText(empty)).not.toBeInTheDocument();
			expect(view.queryByText(/0 (?:departures|départs)/)).not.toBeInTheDocument();

			await view.rerender({ detail: answered });
			expect(view.getByText(heading)).toBeVisible();
			expect(view.getByText(empty)).toBeVisible();
			expect(view.queryByText(noLive)).not.toBeInTheDocument();
			expect(view.queryByText(/0 (?:departures|départs)/)).not.toBeInTheDocument();
		},
	);
});

describe.each([
	['en', /Next stop:\s*Unknown/, 'No live data', /0 vehicles in view/],
	['fr', /Prochain arrêt\s*:\s*Inconnu/, 'Aucune donnée en direct', /0 véhicules en vue/],
] as const)('selected entity states in %s', (locale, nextStop, noLive, noVehicles) => {
	const panelProps = {
		locale,
		url: new URL('https://transit.example/map'),
		city: 'stm',
		vehiclesInView: null,
	};

	it.each([null, 'stop-not-in-schedule'])('labels an unknown next stop (%s)', (next_stop) => {
		const index = buildLiveIndex({
			vehicles: {
				generated_utc: utc('2026-06-15T00:00:00Z'),
				vehicles: [
					{
						id: 'vehicle-1',
						lat: 45.51,
						lon: -73.57,
						status: 'unknown',
						updated_utc: utc('2026-06-15T00:00:00Z'),
						route: null,
						trip: null,
						next_stop,
						bearing: null,
						delay_min: null,
						occupancy: null,
					},
				],
			},
		});
		const detail = resolveMapSelection({ kind: 'vehicle', id: 'vehicle-1' }, { index, stops });
		if (detail?.kind !== 'vehicle') throw new Error('expected vehicle details');

		const view = render(MapSelectionSummary, { ...panelProps, detail });
		expect(view.getByText(nextStop)).toBeVisible();
	});

	it('distinguishes an unavailable line count from an answered zero', async () => {
		const route = {
			id: '24',
			generated_utc: utc('2026-06-15T00:00:00Z'),
			directions: [],
		};
		const detail = resolveMapSelection(
			{ kind: 'route', id: route.id },
			{ index: buildLiveIndex({}), routes: [route], stops },
		);
		if (detail?.kind !== 'route') throw new Error('expected line details');

		const view = render(MapSelectionSummary, { ...panelProps, detail });
		expect(view.container.querySelector('[data-record-state="no_live_data"]')).toHaveTextContent(
			noLive,
		);
		expect(view.queryByText(noVehicles)).not.toBeInTheDocument();

		await view.rerender({ vehiclesInView: 0 });
		expect(view.getByText(noVehicles)).toBeVisible();
		expect(view.queryByText(noLive)).not.toBeInTheDocument();
	});
});
