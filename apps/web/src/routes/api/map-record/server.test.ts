import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './+server';

const query = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/engine.ts', () => ({ query }));

function request(search: string) {
	const url = new URL(
		'https://transit.yesid.dev/api/map-record?city=stm&layer=corridors&' + search,
	);
	return GET({ url, request: new Request(url) } as Parameters<typeof GET>[0]);
}

const dates = 'from=2026-11-01&to=2026-11-02';

beforeEach(() => query.mockReset());

it.each([
	'from=2026-11-02&to=2026-11-01',
	'from=2026-02-30&to=2026-03-02',
	'from=2024-01-01&to=2026-11-02',
	dates + '&from=2026-11-01',
	dates + '&layer=invalid',
	dates + '&hour_from=7',
	dates + '&hour_from=7&hour_to=7',
	dates + '&route_type=1703',
])('rejects invalid map parameters before querying the engine: %s', async (search) => {
	const response = await request(search);
	expect(response.status).toBe(400);
	expect(query).not.toHaveBeenCalled();
});

it.each([
	[
		{ kind: 'unreachable', status: 409, reason: 'network_corridors_unsupported' },
		409,
		'choose_line',
	],
	[{ kind: 'unreachable', status: 400 }, 400, 'invalid_request'],
	[{ kind: 'unreachable', status: 409 }, 503, 'unavailable'],
	[{ kind: 'busy' }, 503, 'unavailable'],
])(
	'distinguishes map capability from invalid or busy answers: %j',
	async (result, status, state) => {
		query.mockResolvedValueOnce(result);
		const response = await request(dates);
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ state });
	},
);

it('passes the complete selected map scope to the engine', async () => {
	query.mockResolvedValueOnce({ kind: 'busy' });
	const lines = encodeURIComponent('["51","24","51"]');
	await request(dates + `&lines=${lines}&route_type=0&direction=1&hour_from=22&hour_to=06`);
	expect(query).toHaveBeenCalledWith(
		expect.objectContaining({
			parameters: expect.objectContaining({
				lines: '["24","51"]',
				route_type: '0',
				direction: '1',
				hour_from: '22',
				hour_to: '6',
			}),
		}),
		expect.anything(),
		null,
	);
});
