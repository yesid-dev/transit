import { expect, it, vi } from 'vitest';
import { getScheduleShapes, withScheduleShapes } from './scheduleShapes';
import { RouteFileSchema } from '#lib/v1/schemas/route.ts';

const date = '2026-11-23';
const stops = [{ id: 'terminal', seq: 1, name: 'Terminal' }];
const route = RouteFileSchema.parse({
	id: 'A/B,é',
	generated_utc: date + 'T00:00:00Z',
	directions: [
		{ dir: 0, headsign: 'Centre', stops },
		{ dir: 0, headsign: 'Airport', stops },
	],
});
const shape = {
	type: 'LineString',
	coordinates: [
		[1, 2],
		[3, 4],
	],
};

it('requests one canonical line set and overlays the matching branch without touching stop lists', async () => {
	const fetch = vi.fn(async () =>
		Response.json({
			schedule: {
				date,
				route_shapes: {
					[route.id]: [{ dir: 0, headsign: 'Airport', shape }],
				},
			},
		}),
	);
	const maps = await getScheduleShapes(['B', route.id, 'B'], { providerId: 'demo', fetch });

	expect(fetch).toHaveBeenCalledExactlyOnceWith(
		'/api/schedule-map?' +
			new URLSearchParams({
				city: 'demo',
				lines: JSON.stringify([route.id, 'B']),
			}),
	);
	expect(withScheduleShapes(route, maps).directions).toEqual([
		{ dir: 0, headsign: 'Centre', stops },
		{ dir: 0, headsign: 'Airport', stops, shape },
	]);
	expect(
		withScheduleShapes(
			route,
			maps.map((map) => map && { ...map, date: '2026-11-22' }),
		),
	).toBe(route);
});

it('keeps every direction when shapes are unavailable', async () => {
	const fetch = vi.fn(async () => new Response(null, { status: 503 }));
	const maps = await getScheduleShapes([route.id], { providerId: 'demo', fetch });
	expect(withScheduleShapes(route, maps)).toBe(route);
});
