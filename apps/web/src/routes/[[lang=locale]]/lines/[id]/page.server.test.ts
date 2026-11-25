import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
	ctx: { fetch: vi.fn(), providerId: 'octranspo', manifest: { provider: 'octranspo' } },
	getRoute: vi.fn(),
	getRecordAnswer: vi.fn(),
	serverV1Context: vi.fn(),
}));

vi.mock('#lib/server/engine.ts', () => ({ getRecordAnswer: harness.getRecordAnswer }));

vi.mock('#lib/v1/repositories/static.ts', () => ({
	getRoute: (...args: unknown[]) => harness.getRoute(...args),
}));

vi.mock('#lib/v1/serverContext.ts', () => ({
	serverV1Context: (...args: unknown[]) => harness.serverV1Context(...args),
}));

import { load } from './+page.server';

function event(id = '24'): Parameters<typeof load>[0] {
	return {
		params: { id },
		url: new URL(`https://transit.yesid.dev/lines/${id}`),
		fetch: vi.fn(),
		locals: { v1Cache: new Map() },
		platform: undefined,
		parent: async () => ({
			v1: { manifest: harness.ctx.manifest },
			providerId: harness.ctx.providerId,
			provider: {
				inputs: { vehicle_positions: true, trip_updates: true },
				lines_without_live_data: [],
				timezone: 'America/Toronto',
			},
			lang: 'en',
			schedule: { routes: [{ id: '24', short: '24', long: 'Sherbrooke' }], stops: [] },
		}),
		request: new Request(`https://transit.yesid.dev/lines/${id}`),
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	harness.getRoute.mockReset().mockResolvedValue(null);
	harness.getRecordAnswer.mockReset().mockResolvedValue({ kind: 'unconfigured' });
	harness.serverV1Context.mockReset().mockReturnValue(harness.ctx);
});

describe('Line Record and Schedule on transit1', () => {
	const dates = 'recordFrom=2026-11-08&recordTo=2026-11-14';
	function framed(query = '') {
		const request = event('24');
		Object.assign(request, {
			url: new URL('https://transit1.yesid.dev/lines/24?' + dates + query),
		});
		return request;
	}

	it('streams scoped sections independently, including when snapshot boot fails', async () => {
		const request = framed('&direction=1');
		Object.assign(request, {
			parent: async () => ({ v1: null, lang: 'en', providerId: 'octranspo' }),
		});
		harness.getRecordAnswer.mockImplementationOnce(() => new Promise(() => {}));
		const data = await load(request);
		expect(data?.record).toMatchObject({ direction: '1', city: 'octranspo' });
		expect(data?.record?.sections.map(({ section }: { section: string }) => section)).toEqual([
			'punctuality',
			'daily',
			'hourly',
			'directions',
			'stops',
			'waiting',
			'offered',
			'delivery',
			'late',
			'crowding',
			'alerts',
			'frequency',
			'boundaries',
		]);
		const period = expect.objectContaining({
			from: '2026-11-08',
			to: '2026-11-14',
			city: 'octranspo',
		});
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{
				path: '/measure',
				parameters: { measure: 'punctuality', group: 'stop', line: '24', direction: '1' },
			},
			period,
		);
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{
				path: '/ranking',
				parameters: { measure: 'late', kind: 'departure', line: '24', limit: '8', direction: '1' },
			},
			period,
		);
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{ path: '/measure', parameters: { measure: 'alert_counts', line: '24', alert_details: '1' } },
			period,
		);
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{ path: '/measure', parameters: { measure: 'punctuality', group: 'direction', line: '24' } },
			period,
		);
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{ path: '/measure', parameters: { measure: 'waiting_and_gaps', line: '24', direction: '1' } },
			period,
		);
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{
				path: '/measure',
				parameters: { measure: 'scheduled_frequency', group: 'hour', line: '24', direction: '1' },
			},
			period,
		);
		await expect(data?.record?.sections.at(-1)?.answer).resolves.toEqual({ kind: 'unconfigured' });
		expect(harness.getRoute).not.toHaveBeenCalled();
	});

	it('redirects the old Schedule URL with its choices before requesting answers', async () => {
		await expect(load(framed('&tab=schedule&direction=1&dayType=sunday'))).rejects.toMatchObject({
			status: 308,
			location: `/lines/24?${dates}&direction=1&dayType=sunday&frameMode=record#schedule`,
		});
		expect(harness.getRecordAnswer).not.toHaveBeenCalled();
	});

	it('streams capture, predictions and the schedule without requesting a legacy route', async () => {
		const request = framed('&frameMode=live');
		vi.mocked(request.fetch).mockImplementation(() => new Promise(() => {}));
		const data = await load(request);
		expect(data?.frameLive).toBe(true);
		expect(data?.capture).toBeInstanceOf(Promise);
		expect(data?.trips).toBeInstanceOf(Promise);
		expect(data?.record?.sections.map(({ section }: { section: string }) => section)).toEqual([
			'punctuality',
			'frequency',
			'boundaries',
		]);
		expect(vi.mocked(request.fetch).mock.calls.map(([url]) => url)).toEqual([
			'/api/live?city=octranspo',
			'/api/live-trips?city=octranspo&line=24',
		]);
		expect(harness.getRoute).not.toHaveBeenCalled();
		expect(harness.serverV1Context).not.toHaveBeenCalled();
	});

	it('keeps old live addresses and only reads the selected mode', async () => {
		await expect(load(framed('&tab=detail'))).rejects.toMatchObject({
			status: 308,
			location: `/lines/24?${dates}&frameMode=live`,
		});
		expect(harness.getRecordAnswer).not.toHaveBeenCalled();
	});

	it('reports an id absent from the timetable before asking for readings', async () => {
		const request = framed('&frameMode=live');
		request.params.id = 'unknown';
		await expect(load(request)).rejects.toMatchObject({
			status: 404,
			body: { message: 'This line is not in the timetable.' },
		});
		expect(request.fetch).not.toHaveBeenCalled();
		expect(harness.getRecordAnswer).not.toHaveBeenCalled();
	});
});
