import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { loadStopRecord } from '#lib/server/stopRecord.ts';

const harness = vi.hoisted(() => ({
	getRecordAnswer: vi.fn(),
}));

vi.mock('#lib/server/engine.ts', () => ({ getRecordAnswer: harness.getRecordAnswer }));

import { load } from './+page.server';

function event({
	id = 'S1',
	query = 'frameMode=live',
	tripUpdates = true,
	scheduleOnly = false,
} = {}) {
	const url = new URL(`https://transit.yesid.dev/stop/${id}?${query}`);
	const fetch = vi.fn(() => new Promise<Response>(() => {}));
	return {
		params: { id },
		url,
		fetch,
		request: new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.24' } }),
		parent: async () => ({
			lang: 'en',
			providerId: 'stm',
			provider: {
				inputs: { trip_updates: tripUpdates },
				lines_without_live_data: scheduleOnly ? [{ route_ids: [], route_types: [1] }] : [],
			},
			schedule: {
				stops: [{ id: 'S1', name: '  Van Horne / Rockland ', code: '56789', routes: ['24'] }],
				routes: [{ id: '24', type: 1 }],
			},
		}),
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	harness.getRecordAnswer.mockReset().mockResolvedValue({ kind: 'unconfigured' });
});

describe('Stop capture and Record loading', () => {
	it.each(['next', 'info', 'unknown', 'reliability'])(
		'preserves other parameters when removing the %s tab',
		async (tab) => {
			await expect(load(event({ query: `tab=${tab}&line=51` }))).rejects.toMatchObject({
				status: 308,
				location: '/stop/S1?line=51',
			});
		},
	);

	it('redirects the old Detail address to Live', async () => {
		await expect(load(event({ query: 'tab=detail&provider=stm' }))).rejects.toMatchObject({
			status: 308,
			location: '/stop/S1?provider=stm&frameMode=live',
		});
	});

	it('streams the capture and stop-scoped trips with a shared schedule title', async () => {
		const request = event();
		const data = await load(request);
		expect(data).toMatchObject({
			seed: { id: 'S1', name: 'Van Horne / Rockland' },
			seoTitle: 'Van Horne / Rockland (stop 56789)',
			frameLive: true,
			record: null,
			capture: expect.any(Promise),
			trips: expect.any(Promise),
		});
		expect(vi.mocked(request.fetch).mock.calls.map(([url]) => url)).toEqual([
			'/api/live?city=stm',
			'/api/live-trips?city=stm&stop=S1',
		]);
		expect(harness.getRecordAnswer).not.toHaveBeenCalled();
	});

	it.each([{ scheduleOnly: true }, { tripUpdates: false }])(
		'does not request trip updates for %o',
		async (options) => {
			const request = event(options);
			await expect(load(request)).resolves.toMatchObject({ trips: null });
			expect(vi.mocked(request.fetch).mock.calls.map(([url]) => url)).toEqual([
				'/api/live?city=stm',
			]);
		},
	);

	it('returns a Live state for an absent stop without any upstream request', async () => {
		const request = event({ id: 'archived' });
		await expect(load(request)).resolves.toMatchObject({
			outsideCurrentTimetable: true,
			record: null,
			trips: null,
			capture: null,
		});
		expect(request.fetch).not.toHaveBeenCalled();
	});

	it('streams the dated Record for an archived stop without requesting legacy identity', async () => {
		const request = event({ id: 'archived', query: 'recordFrom=2026-10-20&recordTo=2026-10-21' });
		const slow = new Promise(() => {});
		harness.getRecordAnswer.mockReturnValueOnce(slow);
		const data = await load(request);
		expect(data).toMatchObject({
			outsideCurrentTimetable: true,
			seed: { id: 'archived' },
			trips: null,
		});
		const record: ReturnType<typeof loadStopRecord> | null | undefined = data?.record;
		expect(record?.sections.find(({ section }) => section === 'punctuality')?.answer).toBe(slow);
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{ path: '/measure', parameters: { measure: 'punctuality', stop: 'archived' } },
			expect.objectContaining({ from: '2026-10-20', to: '2026-10-21', visitorIp: '192.0.2.24' }),
		);
		expect(request.fetch).not.toHaveBeenCalled();
	});
});
