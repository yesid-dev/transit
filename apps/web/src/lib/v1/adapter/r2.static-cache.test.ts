import { afterEach, expect, it, vi } from 'vitest';
import { getMapRouteDirections, staticPort } from './r2.static';

vi.mock('$app/env', () => ({ browser: true }));

const schedule = {
	date: '2026-11-21',
	routes: [{ id: '24', short: '24', long: 'Sherbrooke', type: 3 }],
	stops: [],
	route_directions: { '24': [{ dir: 0, headsign: 'East' }] },
};

afterEach(() => vi.unstubAllGlobals());

it('reuses the schedule edition for the map directory and direction readers', async () => {
	const fetcher = vi.fn(() => Promise.resolve(Response.json({ schedule })));
	vi.stubGlobal('fetch', fetcher);
	const context = { providerId: 'stm', cache: new Map<string, unknown>() };

	const routes = await staticPort.routesIndex(context);
	expect(routes.routes[0]?.id).toBe('24');
	expect(await getMapRouteDirections(context)).toEqual(schedule.route_directions);
	expect(fetcher).toHaveBeenCalledOnce();
});

it('lets another reader retry a failed schedule edition in the same map', async () => {
	const fetcher = vi
		.fn()
		.mockRejectedValueOnce(new Error('network unavailable'))
		.mockResolvedValueOnce(Response.json({ schedule }));
	vi.stubGlobal('fetch', fetcher);
	const context = { providerId: 'stm', cache: new Map<string, unknown>() };

	await expect(staticPort.routesIndex(context)).rejects.toThrow('network unavailable');
	expect(await getMapRouteDirections(context)).toEqual(schedule.route_directions);
	expect(fetcher).toHaveBeenCalledTimes(2);
});
