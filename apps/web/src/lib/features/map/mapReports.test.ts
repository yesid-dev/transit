import { describe, expect, it } from 'vitest';
import type { FilterState } from '#lib/filters/index.ts';
import { emptyFilterState } from '#lib/filters/index.ts';
import type { Vehicle, VehiclesFile } from '#lib/v1/schemas/index.ts';
import { buildMapReportView, mapReportFilterTokens, type MapReportInput } from './mapReports';
import type { MapReportCamera } from './mapReportCamera';

const NOW = Date.parse('2026-11-16T21:00:00Z');

function vehicle(overrides: Record<string, unknown> = {}): Vehicle {
	return {
		id: 'bus-1',
		lat: 45.5,
		lon: -73.6,
		status: 'on_time',
		updated_utc: '2026-11-16T20:59:30Z',
		trip: 'trip-1',
		route: '24',
		next_stop: 'stop-1',
		...overrides,
	} as unknown as Vehicle;
}

function file(vehicles: Vehicle[], overrides: Record<string, unknown> = {}): VehiclesFile {
	return {
		generated_utc: '2026-11-16T20:59:40Z',
		publish_generation_id: 'gen-1',
		methodology_version: 'm1',
		vehicles,
		...overrides,
	} as unknown as VehiclesFile;
}

/** Pixel projection: x = (lon + 74) * 1000, y = (46 - lat) * 1000. */
const camera: MapReportCamera = {
	center: [-73.6, 45.5],
	zoom: 11,
	bearing: 0,
	pitch: 0,
	width: 1000,
	height: 1000,
	bbox: { west: -74, south: 45, east: -73, north: 46 },
	project: ([lon, lat]) => ({ x: (lon + 74) * 1000, y: (46 - lat) * 1000 }),
};

function input(overrides: Partial<MapReportInput> = {}): MapReportInput {
	return {
		source: file([vehicle()]),
		health: { retained: true, failing: false, stale: false },
		filter: emptyFilterState(),
		alertVehicleIds: new Set<string>(),
		alertPublication: {
			generated_utc: '2026-11-16T20:58:00Z',
			publish_generation_id: 'alerts-1',
			methodology_version: 'alerts-method',
		},
		alertHealth: { retained: true, failing: false, stale: false },
		camera,
		serverNow: NOW,
		staleCutoffS: 150,
		providerId: 'stm',
		providerName: 'STM',
		locale: 'en',
		timeZone: 'America/Toronto',
		attribution: 'Source credit',
		filters: [],
		...overrides,
	};
}

function model(overrides: Partial<MapReportInput> = {}) {
	const view = buildMapReportView(input(overrides));
	if (view.kind !== 'ready') throw new Error(`expected a ready view, got ${view.kind}`);
	return view.model;
}

function ids(view: ReturnType<typeof buildMapReportView>): string[] {
	if (view.kind !== 'ready') throw new Error('not ready');
	return view.model.rows.map((row) => row.vehicleId);
}

describe('map report view', () => {
	it('keeps unknown alert-filter evidence unavailable and retains known last-available matches', () => {
		const filter = { ...emptyFilterState(), alerts: ['has_alert' as const] };
		expect(buildMapReportView(input({ filter, alertPublication: null }))).toEqual({
			kind: 'unavailable',
			reason: 'alerts',
		});
		expect(
			buildMapReportView(
				input({
					filter,
					alertPublication: null,
					alertHealth: { retained: false, failing: false, stale: false, loading: true },
				}),
			),
		).toEqual({ kind: 'loading', reason: 'alerts' });
		const retained = model({
			filter,
			alertVehicleIds: new Set(['bus-1']),
			alertHealth: { retained: true, failing: true, stale: true },
		});
		expect(retained.rows.map((row) => row.vehicleId)).toEqual(['bus-1']);
		expect(retained.alertFilter).toEqual({
			generatedUtc: '2026-11-16T20:58:00Z',
			generationId: 'alerts-1',
			methodVersion: 'alerts-method',
			dataState: 'last_available',
		});
		expect(retained.generatedUtc).toBe('2026-11-16T20:59:40Z');
		expect(model({ alertPublication: null }).alertFilter).toBeNull();
	});

	it('keeps different opaque restrictions distinct while a clipboard operation is pending', () => {
		const joined = emptyFilterState();
		joined.routes.add('a|stop:b');
		const separate = emptyFilterState();
		separate.routes.add('a');
		separate.stops.add('b');
		expect(model({ filter: joined, filters: mapReportFilterTokens(joined) }).identity).not.toBe(
			model({ filter: separate, filters: mapReportFilterTokens(separate) }).identity,
		);
	});

	it('reuses the map renderer predicate for every filter category', () => {
		const vehicles = [
			vehicle({ id: 'on-time' }),
			vehicle({ id: 'late', status: 'late' }),
			vehicle({ id: 'full', occupancy: 'full' }),
			vehicle({ id: 'route-9', route: '9' }),
			vehicle({ id: 'stop-9', next_stop: 'stop-9' }),
			vehicle({ id: 'trip-9', trip: 'trip-9' }),
			vehicle({ id: 'bus-9', trip: 'trip-9' }),
			vehicle({ id: 'parked', trip: null }),
		];
		const filter: FilterState = {
			...emptyFilterState(),
			status: ['late'],
			occupancy: ['full'],
			routes: new Set(['9']),
			stops: new Set(['stop-9']),
			trips: new Set(['trip-9']),
			vehicles: new Set(['bus-9']),
			entities: ['bus'],
		};
		expect(buildMapReportView(input({ source: file(vehicles), filter })).kind).toBe('ready');
		expect(ids(buildMapReportView(input({ source: file(vehicles), filter })))).toEqual([]);

		expect(
			ids(
				buildMapReportView(
					input({ source: file(vehicles), filter: { ...emptyFilterState(), status: ['late'] } }),
				),
			),
		).toEqual(['late']);
		expect(
			ids(
				buildMapReportView(
					input({ source: file(vehicles), filter: { ...emptyFilterState(), occupancy: ['full'] } }),
				),
			),
		).toEqual(['full']);
		expect(
			ids(
				buildMapReportView(
					input({
						source: file(vehicles),
						filter: { ...emptyFilterState(), routes: new Set(['9']) },
					}),
				),
			),
		).toEqual(['route-9']);
		expect(
			ids(
				buildMapReportView(
					input({
						source: file(vehicles),
						filter: { ...emptyFilterState(), stops: new Set(['stop-9']) },
					}),
				),
			),
		).toEqual(['stop-9']);
		expect(
			ids(
				buildMapReportView(
					input({
						source: file(vehicles),
						filter: { ...emptyFilterState(), trips: new Set(['trip-9']) },
					}),
				),
			),
		).toEqual(['trip-9', 'bus-9']);
		expect(
			ids(
				buildMapReportView(
					input({
						source: file(vehicles),
						filter: { ...emptyFilterState(), vehicles: new Set(['bus-9']) },
					}),
				),
			),
		).toEqual(['bus-9']);
		// Out-of-service vehicles stay out of the map scope unless the reader ticks them in.
		expect(
			ids(
				buildMapReportView(
					input({ source: file(vehicles), filter: { ...emptyFilterState(), entities: ['stop'] } }),
				),
			),
		).toEqual([]);
		expect(
			ids(
				buildMapReportView(
					input({
						source: file(vehicles),
						filter: {
							...emptyFilterState(),
							showOutOfService: true,
							vehicles: new Set(['parked']),
						},
					}),
				),
			),
		).toEqual(['parked']);
	});

	it('shares the alert predicate with the renderer', () => {
		const view = buildMapReportView(
			input({
				source: file([vehicle({ id: 'alerted' }), vehicle({ id: 'quiet' })]),
				filter: { ...emptyFilterState(), alerts: ['has_alert'] },
				alertVehicleIds: new Set(['alerted']),
			}),
		);
		expect(ids(view)).toEqual(['alerted']);
	});

	it('includes the canvas edges and uses projection rather than the envelope', () => {
		const result = model({
			source: file([
				vehicle({ id: 'corner', lon: -74, lat: 46 }),
				vehicle({ id: 'far-corner', lon: -73, lat: 45 }),
				vehicle({ id: 'offscreen-in-envelope', lon: -75, lat: 45.5 }),
			]),
		});
		expect(result.rows.map((row) => row.vehicleId)).toEqual(['corner', 'far-corner']);
		// Offscreen but valid belongs to another viewport, not to an unassignable count.
		expect(result.unscopedMatchingCount).toBe(0);
	});

	it('counts matching vehicles without a usable location separately', () => {
		const result = model({
			source: file([
				vehicle({ id: 'valid' }),
				vehicle({ id: 'nan', lat: Number.NaN }),
				vehicle({ id: 'world', lat: 120 }),
			]),
		});
		expect(result.rows.map((row) => row.vehicleId)).toEqual(['valid']);
		expect(result.inViewCount).toBe(1);
		expect(result.unscopedMatchingCount).toBe(2);
	});

	it('keeps source order and duplicate rows, never summing by vehicle id', () => {
		const result = model({
			source: file([vehicle({ id: 'same' }), vehicle({ id: 'first' }), vehicle({ id: 'same' })]),
		});
		expect(result.rows.map((row) => [row.index, row.vehicleId])).toEqual([
			[0, 'same'],
			[1, 'first'],
			[2, 'same'],
		]);
		expect(result.inViewCount).toBe(3);
	});

	it('states no recent position as an overlapping subset at the cutoff boundary', () => {
		const result = model({
			source: file([
				vehicle({ id: 'fresh', updated_utc: '2026-11-16T20:59:00Z' }),
				vehicle({ id: 'edge', updated_utc: '2026-11-16T20:57:30Z' }),
				vehicle({ id: 'old', updated_utc: '2026-11-16T20:57:29Z' }),
			]),
		});
		expect(result.inViewCount).toBe(3);
		expect(result.noRecentInViewCount).toBe(2);
		expect(result.rows.find((row) => row.vehicleId === 'edge')?.noRecentPosition).toBe(true);
		expect(result.rows.find((row) => row.vehicleId === 'fresh')?.noRecentPosition).toBe(false);
	});

	it('falls back to the source update time and says so', () => {
		const result = model({
			source: file([
				vehicle({ id: 'reported', reported_utc: '2026-11-16T20:58:00Z' }),
				vehicle({ id: 'fallback', reported_utc: null, updated_utc: '2026-11-16T20:58:30Z' }),
			]),
		});
		const byId = new Map(result.rows.map((row) => [row.vehicleId, row]));
		expect(byId.get('reported')).toMatchObject({
			ageBasis: 'reported_utc',
			ageSeconds: 120,
			reportedUtc: '2026-11-16T20:58:00Z',
		});
		expect(byId.get('fallback')).toMatchObject({
			ageBasis: 'updated_utc',
			ageSeconds: 90,
			reportedUtc: null,
			updatedUtc: '2026-11-16T20:58:30Z',
		});
	});

	it('distinguishes loading, no view, no source, and an unusable clock', () => {
		expect(buildMapReportView(input({ source: null, camera: null }))).toEqual({
			kind: 'unavailable',
			reason: 'view',
		});
		expect(buildMapReportView(input({ source: null, health: null }))).toEqual({ kind: 'loading' });
		expect(
			buildMapReportView(
				input({ source: null, health: { retained: false, failing: true, stale: false } }),
			),
		).toEqual({ kind: 'unavailable', reason: 'source' });
		expect(buildMapReportView(input({ serverNow: Number.NaN }))).toEqual({
			kind: 'unavailable',
			reason: 'clock',
		});
	});

	it('returns a true zero from an empty successful snapshot', () => {
		const view = buildMapReportView(input({ source: file([]) }));
		expect(view.kind).toBe('ready');
		if (view.kind !== 'ready') return;
		expect(view.model.rows).toEqual([]);
		expect(view.model.inViewCount).toBe(0);
		expect(view.model.noRecentInViewCount).toBe(0);
	});

	it('keeps the source generation, publication and zone without borrowing the manifest', () => {
		const result = model({
			source: file([], {
				generated_utc: '2026-11-16T20:55:00Z',
				publish_generation_id: 'gen-2',
				methodology_version: null,
			}),
			timeZone: undefined,
		});
		expect(result.generatedUtc).toBe('2026-11-16T20:55:00Z');
		expect(result.publicationGenerationId).toBe('gen-2');
		expect(result.methodologyVersion).toBeNull();
		expect(result.timeZone).toBe('UTC');
		expect(result.evaluatedUtc).toBe('2026-11-16T21:00:00.000Z');
	});

	it('identifies a new snapshot when the file, filters or camera change', () => {
		const base = model({ filters: ['route:24'] });
		expect(model({ filters: ['route:24'] }).identity).toBe(base.identity);
		expect(
			model({
				filters: ['route:24'],
				source: file([vehicle()], { generated_utc: '2026-11-16T20:59:50Z' }),
			}).identity,
		).not.toBe(base.identity);
		expect(model({ filters: ['route:24', 'status:late'] }).identity).not.toBe(base.identity);
		expect(
			model({
				filters: ['route:24'],
				camera: { ...camera, zoom: 12 },
			}).identity,
		).not.toBe(base.identity);
	});

	it('tokenizes the live filter scope without locale labels', () => {
		const filter: FilterState = {
			...emptyFilterState(),
			showOutOfService: true,
			routes: new Set(['9', '24']),
			vehicles: new Set(['bus-1']),
			status: ['late'],
			alerts: ['has_alert'],
		};
		expect(mapReportFilterTokens(filter)).toEqual([
			'show_out_of_service:1',
			'route:24',
			'route:9',
			'vehicle:bus-1',
			'status:late',
			'alert:has_alert',
		]);
	});
});
