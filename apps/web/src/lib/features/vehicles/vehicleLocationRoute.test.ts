import { expect, it } from 'vitest';
import type { RouteDirection, RouteFile } from '#lib/v1/schemas/index.ts';
import { vehicleLocationRoute } from './vehicleLocationRoute.ts';

const east: RouteDirection = {
	dir: 0,
	headsign: 'East',
	shape: {
		type: 'LineString',
		coordinates: [
			[-73.6, 45.5],
			[-73.58, 45.5],
		],
	},
};
const west: RouteDirection = {
	dir: 1,
	headsign: 'West',
	shape: {
		type: 'LineString',
		coordinates: [
			[-73.58, 45.5],
			[-73.6, 45.5],
		],
	},
};
const branch: RouteDirection = {
	...west,
	headsign: 'Station',
	stops: [{ id: 'S2', name: 'Station', seq: 1 }],
};
const route = {
	id: '24',
	generated_utc: '2026-11-27T00:00:00Z',
	directions: [east, west, branch],
} as RouteFile;

it('draws only the live trip direction when its variant is known', () => {
	expect(vehicleLocationRoute(route, 0, null, null)?.directions).toEqual([east]);
	expect(vehicleLocationRoute(route, 1, 'Station', null)?.directions).toEqual([branch]);
	expect(vehicleLocationRoute(route, 1, null, 'S2')?.directions).toEqual([branch]);
});

it('leaves the line off the map when the reported direction cannot identify a shape', () => {
	expect(vehicleLocationRoute(route, 1, null, null)).toBeNull();
	expect(vehicleLocationRoute(route, 2, 'Station', 'S2')).toBeNull();
});
