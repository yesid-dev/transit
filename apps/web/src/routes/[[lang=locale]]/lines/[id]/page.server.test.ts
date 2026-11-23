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
		expect(data?.record).toMatchObject({ direction: '1', city: 'octranspo', view: 'record' });
		expect(data?.record?.sections.map(({ section }: { section: string }) => section)).toEqual([
			'punctuality',
			'daily',
			'hourly',
			'directions',
			'stops',
			'delivery',
			'late',
			'crowding',
			'alerts',
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
			{ path: '/measure', parameters: { measure: 'alert_counts', line: '24' } },
			period,
		);
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{ path: '/measure', parameters: { measure: 'punctuality', group: 'direction', line: '24' } },
			period,
		);
		await expect(data?.record?.sections.at(-1)?.answer).resolves.toEqual({ kind: 'unconfigured' });
		expect(harness.getRoute).not.toHaveBeenCalled();
	});

	it('only asks for scheduled frequency and boundaries on Schedule', async () => {
		const data = await load(framed('&tab=schedule&direction=invalid'));
		expect(data?.record?.view).toBe('schedule');
		expect(harness.getRecordAnswer.mock.calls.map(([query]) => query.parameters)).toEqual([
			{ line: '24', measure: 'scheduled_frequency' },
			{ line: '24', measure: 'service_delivered', group: 'day_type' },
		]);
	});

	it('keeps Live on the existing route data and makes no engine reads', async () => {
		const data = await load(framed('&frameMode=live&tab=detail'));
		expect(data?.frameLive).toBe(true);
		expect(data?.record).toBeUndefined();
		expect(harness.getRoute).toHaveBeenCalledOnce();
		expect(harness.getRecordAnswer).not.toHaveBeenCalled();
	});
});
