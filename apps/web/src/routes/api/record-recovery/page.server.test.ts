import { expect, it, vi } from 'vitest';
import { GET } from './+server.ts';

const { getRecordAnswer, getVehicleDayAnswers } = vi.hoisted(() => ({
	getRecordAnswer: vi.fn(async () => ({ kind: 'busy' })),
	getVehicleDayAnswers: vi.fn(),
}));
vi.mock('#lib/server/engine.ts', () => ({ getRecordAnswer, getVehicleDayAnswers }));

it('reads only the missing Vehicle sections with the original cut and visitor', async () => {
	const url = new URL(
		'https://test.invalid/api/record-recovery?kind=vehicle&city=demo&id=101&from=2026-11-17&to=2026-11-23&sections=days',
	);
	const request = new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.1' } });
	const response = await GET({ request, url } as Parameters<typeof GET>[0]);
	expect(await response.json()).toEqual({ days: { kind: 'busy' } });
	expect(getVehicleDayAnswers).not.toHaveBeenCalled();
	expect(getRecordAnswer).toHaveBeenCalledExactlyOnceWith(
		{ path: '/measure', parameters: { measure: 'vehicles', group: 'day', vehicle: '101' } },
		{ city: 'demo', from: '2026-11-17', to: '2026-11-23', visitorIp: '192.0.2.1', retryBusy: true },
	);
});
