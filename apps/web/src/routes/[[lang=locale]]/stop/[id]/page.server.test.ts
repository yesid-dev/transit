import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
	lang = 'en',
	timetable = true,
}: {
	id?: string;
	query?: string;
	tripUpdates?: boolean;
	scheduleOnly?: boolean;
	lang?: 'en' | 'fr';
	timetable?: boolean;
} = {}) {
	const url = new URL(`https://transit.yesid.dev/stop/${id}?${query}`);
	const fetch = vi.fn(() => new Promise<Response>(() => {}));
	return {
		params: { id },
		url,
		fetch,
		request: new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.24' } }),
		parent: async () => ({
			lang,
			providerId: 'stm',
			provider: {
				inputs: { trip_updates: tripUpdates },
				lines_without_live_data: scheduleOnly ? [{ route_ids: [], route_types: [1] }] : [],
			},
			schedule: timetable
				? {
						stops: [{ id: 'S1', name: '  Van Horne / Rockland ', code: '56789', routes: ['24'] }],
						routes: [{ id: '24', type: 1 }],
					}
				: null,
		}),
	} as unknown as Parameters<typeof load>[0];
}

const dated = 'recordFrom=2026-10-20&recordTo=2026-10-21';
// The identity question spans the whole record, not the dates on screen.
const identityQuery = (stop: string) => [
	{ path: '/measure', parameters: { measure: 'on_time', group: 'stop_id', stop } },
	expect.objectContaining({ from: '2026-10-13', to: '2026-11-24', city: 'stm' }),
];
const identity = (stop: string | null, days = ['2026-10-20']) => ({
	kind: 'answer',
	answer: { evidence: { days_included: days }, cells: stop ? [{ key: { stop } }] : [] },
});

afterEach(() => vi.useRealTimers());

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
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

	it('keeps Live available for an archived stop without requesting capture', async () => {
		harness.getRecordAnswer.mockResolvedValueOnce(identity('archived'));
		const request = event({ id: 'archived' });
		await expect(load(request)).resolves.toMatchObject({
			outsideCurrentTimetable: true,
			record: null,
			trips: null,
			capture: null,
		});
		expect(request.fetch).not.toHaveBeenCalled();
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(...identityQuery('archived'));
	});

	it('streams the dated Record for an archived stop without requesting legacy identity', async () => {
		const request = event({ id: 'archived', query: 'recordFrom=2026-10-20&recordTo=2026-10-21' });
		const slow = new Promise(() => {});
		harness.getRecordAnswer.mockResolvedValueOnce(identity('archived')).mockReturnValueOnce(slow);
		const data = await load(request);
		expect(data).toMatchObject({
			outsideCurrentTimetable: true,
			seed: { id: 'archived' },
			trips: null,
		});
		const record: ReturnType<typeof loadStopRecord> | null | undefined = data?.record;
		expect(record?.sections.find(({ section }) => section === 'punctuality')?.answer).toBe(slow);
		expect(harness.getRecordAnswer).toHaveBeenNthCalledWith(1, ...identityQuery('archived'));
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{ path: '/measure', parameters: { measure: 'punctuality', stop: 'archived' } },
			expect.objectContaining({ from: '2026-10-20', to: '2026-10-21', visitorIp: '192.0.2.24' }),
		);
		expect(request.fetch).not.toHaveBeenCalled();
	});

	it('keeps a current stop on the timetable without an identity question', async () => {
		const pending = Promise.withResolvers<unknown>();
		harness.getRecordAnswer.mockReturnValueOnce(pending.promise);
		await expect(load(event({ query: dated }))).resolves.toMatchObject({
			seed: { id: 'S1', name: 'Van Horne / Rockland' },
			outsideCurrentTimetable: false,
			record: { delivery: expect.any(Promise) },
		});
		expect(harness.getRecordAnswer).not.toHaveBeenCalledWith(...identityQuery('S1'));
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{ path: '/measure', parameters: { measure: 'service_delivered', stop: 'S1' } },
			expect.objectContaining({ from: '2026-10-20', to: '2026-10-21', city: 'stm' }),
		);
		pending.resolve({ kind: 'unconfigured' });
	});

	it.each(['en', 'fr'] as const)(
		'returns the localized 404 for missing stop 57135 in %s',
		async (lang) => {
			harness.getRecordAnswer.mockResolvedValueOnce(identity(null));
			await expect(load(event({ id: '57135', query: dated, lang }))).rejects.toMatchObject({
				status: 404,
				body: {
					code: 'STOP_NOT_FOUND',
					message: lang === 'fr' ? 'Cet arrêt est introuvable.' : 'This stop could not be found.',
				},
			});
			expect(harness.getRecordAnswer).toHaveBeenCalledOnce();
			expect(harness.getRecordAnswer).toHaveBeenCalledWith(...identityQuery('57135'));
		},
	);

	it.each([
		['the engine is unreachable', { kind: 'unreachable' }, true],
		['the dates hold no observed day', identity(null, []), true],
		['the timetable is unavailable', identity(null), false],
	])('returns an unavailable status when %s', async (_, answer, timetable) => {
		harness.getRecordAnswer.mockResolvedValueOnce(answer);
		await expect(load(event({ id: '57135', query: dated, timetable }))).rejects.toMatchObject({
			status: 503,
		});
	});

	it.each([
		['record', dated],
		['live', 'frameMode=live'],
	])('streams a slow %s identity before showing a missing Stop', async (_, query) => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const pending = Promise.withResolvers<unknown>();
		harness.getRecordAnswer.mockReturnValueOnce(pending.promise);
		const shell = load(event({ id: '57135', query }));
		await vi.advanceTimersByTimeAsync(1500);
		const data = await shell;
		expect(data?.seed.id).toBe('57135');
		expect(data?.stopIdentity).toBeInstanceOf(Promise);
		expect(harness.getRecordAnswer).toHaveBeenCalledOnce();
		pending.resolve(identity(null));
		await expect(data?.stopIdentity).resolves.toBe('missing');
		if (data?.record) await expect(data.record.delivery).resolves.toEqual({ kind: 'unreachable' });
		expect(harness.getRecordAnswer).toHaveBeenCalledOnce();
	});

	it('starts delivery only after a slow archived Stop identity is confirmed', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const pending = Promise.withResolvers<unknown>();
		harness.getRecordAnswer.mockReturnValueOnce(pending.promise);
		const page = load(event({ id: 'archived', query: dated }));
		await vi.advanceTimersByTimeAsync(1500);
		const data = await page;
		expect(harness.getRecordAnswer).toHaveBeenCalledOnce();
		pending.resolve(identity('archived'));
		await expect(data?.stopIdentity).resolves.toBe('available');
		await data?.record?.delivery;
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{ path: '/measure', parameters: { measure: 'service_delivered', stop: 'archived' } },
			expect.objectContaining({ from: '2026-10-20', to: '2026-10-21' }),
		);
	});
});
