import { beforeEach, expect, it, vi } from 'vitest';

const { getRecordAnswer, getVehicleDayAnswers } = vi.hoisted(() => ({
	getRecordAnswer: vi.fn(),
	getVehicleDayAnswers: vi.fn(),
}));
vi.mock('./engine.ts', () => ({ getRecordAnswer, getVehicleDayAnswers }));
vi.mock('./recordCsv.ts', () => ({ recordCsvResponse: vi.fn() }));

import { frameClock } from '#lib/site/frameState.ts';
import { loadVehiclePage } from './vehicleRecord.ts';

const dates = 'recordFrom=2026-11-08&recordTo=2026-11-14';
const now = new Date('2026-11-20T15:00:00Z');
const request = new Request('https://transit1.yesid.dev', {
	headers: { 'cf-connecting-ip': '192.0.2.24' },
});
const scope = { city: 'test-city', from: '2026-11-08', to: '2026-11-14', visitorIp: '192.0.2.24' };
const load = (path: string, id?: string) =>
	loadVehiclePage(
		new URL(path, request.url),
		request,
		scope.city,
		frameClock({ timezone: 'UTC' }, now),
		id,
	);

beforeEach(() => {
	getRecordAnswer.mockReset().mockResolvedValue({ kind: 'unreachable' });
	getVehicleDayAnswers.mockReset();
});

it('reads fleet days over the chosen dates without a vehicle cut', () => {
	expect(load(`/vehicles?${dates}`).sections.map(({ section }) => section)).toEqual(['fleet']);
	expect(getRecordAnswer).toHaveBeenCalledExactlyOnceWith(
		{
			path: '/measure',
			parameters: { measure: 'vehicle_days_in_service', group: 'vehicle' },
		},
		expect.objectContaining(scope),
	);
});

it('starts all detail sections without awaiting the slow line breakdown', async () => {
	const pending = new Promise(() => {});
	const days = Promise.resolve({ kind: 'answer' });
	getVehicleDayAnswers.mockReturnValue({ service: Promise.resolve({ kind: 'answer' }), days });
	getRecordAnswer.mockReturnValueOnce(pending);
	const detail = load(`/fr/vehicle/40061?${dates}`, '40061');
	expect(detail.sections.map(({ section }) => section)).toEqual([
		'service',
		'lines',
		'reporting',
		'completion',
		'punctuality',
	]);
	await expect(detail.sections[0].answer).resolves.toEqual({ kind: 'answer' });
	expect(detail.days).toBe(days);
	expect(detail.sections[1].answer).toBe(pending);
	expect(getVehicleDayAnswers).toHaveBeenCalledExactlyOnceWith('40061', scope);
	expect(getRecordAnswer.mock.calls.map(([query]) => query.parameters)).toEqual([
		{ vehicle: '40061', measure: 'vehicle_trips_run', group: 'line' },
		{ vehicle: '40061', measure: 'vehicle_reporting_gaps_per_100_hours' },
		{ vehicle: '40061', measure: 'vehicle_unfinished_trips' },
		{ vehicle: '40061', measure: 'vehicle_on_time' },
	]);
	for (const [, period] of getRecordAnswer.mock.calls) expect(period).toMatchObject(scope);
});

it.each([undefined, '40061'])('skips the engine for live mode (%s)', (id) => {
	expect(load(`/vehicles?frameMode=live&${dates}`, id)).toMatchObject({
		mode: 'live',
		sections: [],
	});
	expect(getRecordAnswer).not.toHaveBeenCalled();
	expect(getVehicleDayAnswers).not.toHaveBeenCalled();
});
