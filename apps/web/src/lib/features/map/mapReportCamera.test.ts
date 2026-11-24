import { describe, expect, it } from 'vitest';
import { emptyFilterState } from '#lib/filters/index.ts';
import { LiveVehiclesFileSchema } from '#lib/v1/schemas/index.ts';
import { buildMapReportView } from './mapReports';
import {
	captureMapReportCamera,
	isCoordinateInCapturedView,
	mapReportCameraKey,
	type MapReportCameraSource,
} from './mapReportCamera';

function source(overrides: Partial<MapReportCameraSource> = {}): MapReportCameraSource {
	const project =
		overrides.project ??
		(([lon, lat]: [number, number]) => ({ x: (lon + 74) * 1000, y: (46 - lat) * 1000 }));
	const handling: MapReportCameraSource = {
		project,
		_camera: {
			transform: {
				clone: () => ({ locationToScreenPoint: ({ lng, lat }) => project([lng, lat]) }),
			},
		},
		getCenter: () => ({ lng: -73.6, lat: 45.5 }),
		getZoom: () => 11,
		getBearing: () => 0,
		getPitch: () => 0,
		getCanvas: () => ({ clientWidth: 1000, clientHeight: 1000 }),
		getBounds: () => ({
			getWest: () => -74,
			getSouth: () => 45,
			getEast: () => -73,
			getNorth: () => 46,
		}),
	};
	return { ...handling, ...overrides };
}

describe('captured map report camera', () => {
	it('keeps its projection when a later source or clock update arrives during camera movement', () => {
		let offset = 0;
		const live = {
			...source({ project: () => ({ x: 20 + offset, y: 20 }) }),
			_camera: {
				transform: {
					clone: () => {
						const capturedOffset = offset;
						return { locationToScreenPoint: () => ({ x: 20 + capturedOffset, y: 20 }) };
					},
				},
			},
		};
		const camera = captureMapReportCamera(live)!;
		const before = camera.project([-73.6, 45.5]);
		const vehicle = {
			id: 'first',
			lat: 45.5,
			lon: -73.6,
			status: 'on_time' as const,
			trip: 'trip',
			updated_utc: '2026-11-16T20:59:30Z',
		};
		const input = {
			camera,
			filter: emptyFilterState(),
			alertVehicleIds: new Set<string>(),
			health: null,
			serverNow: Date.parse('2026-11-16T21:00:00Z'),
			staleCutoffS: 150,
			providerId: 'stm',
			providerName: 'STM',
			locale: 'en' as const,
			filters: [],
		};
		const previous = buildMapReportView({
			...input,
			source: LiveVehiclesFileSchema.parse({
				generated_utc: '2026-11-16T20:59:40Z',
				vehicles: [vehicle],
			}),
		});
		offset = 2000;
		const refreshed = buildMapReportView({
			...input,
			serverNow: input.serverNow + 1000,
			source: LiveVehiclesFileSchema.parse({
				generated_utc: '2026-11-16T21:00:00Z',
				vehicles: [vehicle, { ...vehicle, id: 'second' }],
			}),
		});
		if (previous.kind !== 'ready' || refreshed.kind !== 'ready')
			throw new Error('ready captures required');
		expect(previous.model.inViewCount).toBe(1);
		expect(refreshed.model.rows.map((row) => row.vehicleId)).toEqual(['first', 'second']);
		expect(refreshed.model.camera).toEqual(previous.model.camera);
		expect(refreshed.model.generatedUtc).toBe('2026-11-16T21:00:00Z');
		expect(camera.project([-73.6, 45.5])).toEqual(before);
		expect(isCoordinateInCapturedView(camera, [-73.6, 45.5])).toBe(true);
		expect(camera.center).toEqual([-73.6, 45.5]);
	});

	it('copies the settled camera and the actual canvas size', () => {
		const camera = captureMapReportCamera(source())!;
		expect(camera).toMatchObject({
			center: [-73.6, 45.5],
			zoom: 11,
			bearing: 0,
			pitch: 0,
			width: 1000,
			height: 1000,
			bbox: { west: -74, south: 45, east: -73, north: 46 },
		});
	});

	it('is unavailable before the map exists or without a real box', () => {
		expect(captureMapReportCamera(null)).toBeNull();
		expect(captureMapReportCamera(source({ _camera: undefined }))).toBeNull();
		expect(
			captureMapReportCamera(source({ getCanvas: () => ({ clientWidth: 0, clientHeight: 800 }) })),
		).toBeNull();
		expect(captureMapReportCamera(source({ getZoom: () => Number.NaN }))).toBeNull();
	});

	it('includes only finite projections inside the captured rectangle', () => {
		const camera = captureMapReportCamera(source())!;
		expect(isCoordinateInCapturedView(camera, [-74, 46])).toBe(true);
		expect(isCoordinateInCapturedView(camera, [-73, 45])).toBe(true);
		expect(isCoordinateInCapturedView(camera, [-73.6, 45.5])).toBe(true);
		expect(isCoordinateInCapturedView(camera, [-75, 45.5])).toBe(false);
		expect(isCoordinateInCapturedView(camera, [Number.NaN, 45.5])).toBe(false);
	});

	it('ignores the envelope around a rotated view', () => {
		// The real map projects a coordinate near a rotated corner outside the canvas even though
		// the axis-aligned envelope still covers it.
		const camera = captureMapReportCamera(source({ project: () => ({ x: 1200, y: 400 }) }))!;
		expect(camera.bbox.west).toBe(-74);
		expect(isCoordinateInCapturedView(camera, [-73.9, 45.5])).toBe(false);
	});

	it('changes its key only with the camera', () => {
		const camera = captureMapReportCamera(source())!;
		const same = captureMapReportCamera(source())!;
		const moved = captureMapReportCamera(source({ getZoom: () => 12 }))!;
		expect(mapReportCameraKey(camera)).toBe(mapReportCameraKey(same));
		expect(mapReportCameraKey(camera)).not.toBe(mapReportCameraKey(moved));
		expect(mapReportCameraKey(null)).toBe('no-view');
	});
});
