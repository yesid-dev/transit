import { expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({
	bucket: vi.fn(),
	legacy: vi.fn(),
	engine: vi.fn<(request: Request) => Promise<Response>>(),
}));
vi.mock('cloudflare:workers', () => ({
	env: {
		SNAPSHOTS: { get: ports.bucket },
		DATA: { fetch: ports.legacy },
		QUESTION_PROXY: { fetch: ports.engine },
	},
}));

import { GET as live } from '../../api/live/+server';
import { load } from './+page.server';

it.each(['live', 'record'] as const)(
	'serves Data health %s without the old snapshots bucket or /v1',
	async (mode) => {
		vi.clearAllMocks();
		ports.engine.mockImplementation(async (request) => {
			const path = new URL(request.url).pathname;
			if (path.endsWith('/live'))
				return Response.json({
					version: 2,
					city: 'stm',
					published_at: '2026-11-24T12:00:00Z',
					feeds: {},
					stable_vehicle_ids: true,
					vehicle_positions: [],
					alerts: null,
				});
			if (path.endsWith('/how-we-measure')) return Response.json([]);
			return new Response(null, { status: 503, headers: { 'retry-after': '30' } });
		});
		const url = new URL(
			`https://transit.yesid.dev/status?provider=stm&frameMode=${mode}&recordFrom=2026-11-11&recordTo=2026-11-14`,
		);
		const appFetch = vi.fn(async (input: RequestInfo | URL) => {
			const target = new URL(String(input), url);
			if (target.pathname !== '/api/live') throw new Error(`Unexpected app request ${target}`);
			return live({ url: target, request: new Request(target) } as Parameters<typeof live>[0]);
		});
		const data = await load({
			url,
			request: new Request(url),
			fetch: appFetch,
			locals: {},
			parent: async () => ({
				providerId: 'stm',
				provider: {},
				v1: { manifest: { provider: 'stm' } },
			}),
		} as unknown as Parameters<typeof load>[0]);
		expect(data?.view).toBe(mode);
		if (data?.view === 'live') {
			await expect(data.capture).resolves.toMatchObject({ city: 'stm', version: 2 });
			expect(data.diagnostics?.sections).toHaveLength(6);
			await Promise.all(data.diagnostics?.sections.map(({ answer }) => answer) ?? []);
		}
		if (data?.view === 'record' && data.record) {
			await expect(data.record.methods).resolves.toEqual({ kind: 'answer', answer: [] });
			await expect(data.record.health).resolves.toEqual({ kind: 'busy' });
		}
		expect(ports.bucket).not.toHaveBeenCalled();
		expect(ports.legacy).not.toHaveBeenCalled();
		expect(appFetch.mock.calls.map(([input]) => String(input))).toEqual(
			mode === 'live' ? ['/api/live?city=stm'] : [],
		);
		const paths = ports.engine.mock.calls.map(([request]) => new URL(request.url).pathname).sort();
		expect(paths).toEqual(
			mode === 'live'
				? ['/v2/stm/live', ...Array(6).fill('/v2/stm/measure')]
				: ['/v2/how-we-measure', '/v2/stm/data-health'],
		);
	},
);
