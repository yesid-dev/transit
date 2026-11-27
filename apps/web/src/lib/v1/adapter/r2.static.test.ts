import { expect, it, vi } from 'vitest';
import { ManifestSchema } from '#lib/v1/schemas/manifest.ts';
import { r2Adapter } from './r2';
// Load the fixture's adapter module before the individual request assertions run.
import './r2.static';

const shape = {
	type: 'LineString',
	coordinates: [
		[-73.5, 45.5],
		[-73.6, 45.51],
	],
};
const schedule = {
	date: '2026-11-23',
	routes: [{ id: 'A/B', short: 'A', type: 0 }],
	stops: [{ id: '../é', name: 'É', lat: 45.5, lon: -73.5, routes: ['A/B'] }],
	route_directions: { 'A/B': [{ dir: 0, shape, stops: [{ id: '../é', seq: 1 }] }] },
};

it('projects stop metadata from one clean schedule edition and strips geometry', async () => {
	const fetch = vi.fn(async () => Response.json({ schedule }));
	const ctx = { fetch, providerId: 'demo', cache: new Map<string, unknown>() };
	const route = await r2Adapter.static.route('A/B', ctx);
	expect(route).toMatchObject({
		id: 'A/B',
		directions: [{ stops: [{ id: '../é', name: 'É' }] }],
	});
	expect(route?.directions?.[0]).not.toHaveProperty('shape');
	await expect(r2Adapter.static.stop('../é', ctx)).resolves.toMatchObject({
		id: '../é',
		routes_served: ['A/B'],
	});
	await expect(r2Adapter.static.route('unknown', ctx)).resolves.toBeNull();
	expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/schedule-edition?city=demo');
});

it('keeps a missing edition distinct from a missing entity and resolves the declared basemap locally', async () => {
	const fetch = vi.fn(async () => Response.json({ schedule: null }));
	const url = 'https://data.yesid.dev/v2/demo/basemap/region.pmtiles';
	const manifest = ManifestSchema.parse({
		provider: 'demo',
		display_name: 'Demo',
		bbox: [],
		attribution: '',
		dataset_version: 'demo',
		labels: {},
		surfaces: [],
		basemap: url,
		files: { live: { generated_utc: '2026-11-23T00:00:00Z' } },
	});
	await expect(r2Adapter.basemap.get({ manifest, fetch })).resolves.toMatchObject({ url });
	await expect(r2Adapter.basemap.get({ fetch })).resolves.toBeNull();
	expect(fetch).not.toHaveBeenCalled();
	await expect(r2Adapter.static.stop('missing', { manifest, fetch })).rejects.toThrow(
		'edition unavailable',
	);
});
