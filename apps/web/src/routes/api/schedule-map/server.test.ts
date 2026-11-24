import { beforeEach, expect, it, vi } from 'vitest';
import { GET as map } from './+server';
import { GET as edition } from '../schedule-edition/+server';

const proxy = vi.hoisted(() => ({ fetch: vi.fn<(request: Request) => Promise<Response>>() }));
vi.mock('cloudflare:workers', () => ({ env: { QUESTION_PROXY: proxy } }));

const shape = {
	type: 'LineString',
	coordinates: [
		[1, 2],
		[3, 4],
	],
};
const branch = { dir: 0, headsign: 'Centre', stops: [{ id: 's', seq: 1 }], shape };
const date = '2026-11-23';
const mapParams = new URLSearchParams({ city: 'demo', lines: JSON.stringify(['B', 'A/B,é']) });

function request(handler: typeof map, path: string) {
	const url = new URL(path, 'https://transit.example');
	return handler({ url, request: new Request(url) } as Parameters<typeof map>[0]);
}

beforeEach(() => {
	proxy.fetch.mockReset();
});

it('serves the edition from only the schedule index and strips shape fields', async () => {
	proxy.fetch.mockResolvedValueOnce(
		Response.json({ schedule: { date, routes: [], stops: [], route_directions: { A: [branch] } } }),
	);
	const response = await request(edition, '/api/schedule-edition?city=demo');
	const body = await response.json();
	expect(body.schedule.route_directions.A).toEqual([
		{ dir: 0, headsign: 'Centre', stops: branch.stops },
	]);
	expect(proxy.fetch).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			url: 'https://data.yesid.dev/v2/demo/schedule-index',
		}),
	);
});

it.each(['honors', 'ignores', 'rejects'] as const)(
	'returns only requested shapes when the engine %s the cut',
	async (mode) => {
		proxy.fetch.mockImplementation(async (input) => {
			const url = new URL(input.url);
			expect(url.pathname).toBe('/v2/demo/schedule-map');
			if (url.search) {
				expect(JSON.parse(url.searchParams.get('lines')!)).toEqual(['A/B,é', 'B']);
				if (mode === 'rejects') return new Response(null, { status: 400 });
			}
			return Response.json({
				schedule: {
					date,
					route_shapes: {
						'A/B,é': [branch],
						...(mode === 'honors' ? {} : { unrelated: 'never validate this line' }),
					},
				},
			});
		});
		const response = await request(map, '/api/schedule-map?' + mapParams);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=300');
		expect(await response.json()).toEqual({
			schedule: {
				date,
				route_shapes: {
					'A/B,é': [{ dir: 0, headsign: 'Centre', shape }],
				},
			},
		});
		expect(proxy.fetch).toHaveBeenCalledTimes(mode === 'rejects' ? 2 : 1);
	},
);
