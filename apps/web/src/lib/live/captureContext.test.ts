import { expect, it } from 'vitest';
import { captureContext } from './captureContext';
import { PublicCitySchema } from '#lib/v1/schemas/providers.ts';

const city = PublicCitySchema.parse({
	id: 'stm',
	labels: {
		en: { city: 'Montréal', operator: 'STM' },
		fr: { city: 'Montréal', operator: 'STM' },
	},
	timezone: 'America/Toronto',
	bounds: null,
	lines_without_live_data: [],
	inputs: { static_schedule: true, vehicle_positions: true },
	alert_links: {},
});

it('uses the published v2 basemap URL when it belongs to the selected city', () => {
	const url = 'https://data.yesid.dev/v2/stm/basemap/new-montreal.pmtiles';
	expect(captureContext({ ...city, basemap_v2_url: url }, 'en', null).manifest.basemap).toBe(url);
});

it('keeps a same-origin v2 basemap path from a local preview gateway', () => {
	const path = '/v2/stm/basemap/montreal.pmtiles';
	expect(captureContext({ ...city, basemap_v2_url: path }, 'en', null).manifest.basemap).toBe(path);
});

it.each([
	undefined,
	null,
	'/data/v1/stm/static/basemap/montreal.pmtiles',
	'https://data.yesid.dev/v2/octranspo/basemap/ottawa.pmtiles',
	'https://transit.yesid.dev/v2/stm/basemap/montreal.pmtiles',
	'/v2/octranspo/basemap/ottawa.pmtiles',
	'//elsewhere.example/v2/stm/basemap/montreal.pmtiles',
])('omits the basemap if the published URL is unusable (%s)', (basemap_v2_url) => {
	const context = captureContext({ ...city, basemap_v2_url }, 'fr', null);
	expect(context.manifest.basemap).toBeNull();
});
