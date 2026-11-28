import { expect, it, vi } from 'vitest';
import type { MapReportCamera } from './mapReportCamera';
import { isMarkInCapturedView } from './recordMarkInView';

const bbox = { west: -74, south: 45, east: -73, north: 46 };
const camera = (bearing = 0, pitch = 0) => {
	const project = vi.fn(([lon, lat]: readonly [number, number]) => ({
		x: (lon + 74) * 100,
		y: (46 - lat) * 100,
	}));
	return {
		camera: {
			center: [-73.5, 45.5],
			zoom: 10,
			bearing,
			pitch,
			width: 100,
			height: 100,
			bbox,
			project,
		} as MapReportCamera,
		project,
	};
};

it('reads a flat camera from its bounds without projecting each mark', () => {
	const { camera: flat, project } = camera();
	expect(isMarkInCapturedView(flat, { type: 'Point', coordinates: [-73.5, 45.5] })).toBe(true);
	expect(isMarkInCapturedView(flat, { type: 'Point', coordinates: [-72.5, 45.5] })).toBe(false);
	expect(
		isMarkInCapturedView(flat, {
			type: 'LineString',
			coordinates: [
				[-75, 45.5],
				[-73.5, 45.5],
			],
		}),
	).toBe(true);
	expect(
		isMarkInCapturedView(flat, {
			type: 'LineString',
			coordinates: [
				[-76, 47],
				[-75, 47],
			],
		}),
	).toBe(false);
	expect(project).not.toHaveBeenCalled();
	// Both ends outside, crossing the view.
	expect(
		isMarkInCapturedView(flat, {
			type: 'LineString',
			coordinates: [
				[-75, 45.5],
				[-72, 45.5],
			],
		}),
	).toBe(true);
});

it('projects marks when the camera is rotated or tilted', () => {
	const { camera: tilted, project } = camera(0, 50);
	isMarkInCapturedView(tilted, { type: 'Point', coordinates: [-73.5, 45.5] });
	expect(project).toHaveBeenCalled();
});
