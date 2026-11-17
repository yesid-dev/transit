import { describe, expect, it } from 'vitest';
import {
	captureMapReportCamera,
	isCoordinateInCapturedView,
	mapReportCameraKey,
	type MapReportCameraSource,
} from './mapReportCamera';

function source(overrides: Partial<MapReportCameraSource> = {}): MapReportCameraSource {
	const handling: MapReportCameraSource = {
		project: ([lon, lat]: [number, number]) => ({ x: (lon + 74) * 1000, y: (46 - lat) * 1000 }),
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
