import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './+server.ts';

const engine = vi.hoisted(() => ({
	getRecordAnswer: vi.fn(async () => ({ kind: 'busy' })),
	getVehicleDayAnswers: vi.fn(),
	getDelayDistribution: vi.fn(async () => ({ kind: 'busy' })),
	getMeasure: vi.fn(async () => ({ kind: 'busy' })),
	getRanking: vi.fn(async () => ({ kind: 'busy' })),
	getScheduleEdition: vi.fn(async () => null),
	getCityCatalog: vi.fn(),
}));
vi.mock('#lib/server/engine.ts', () => engine);

beforeEach(() => vi.clearAllMocks());

function ask(parameters: string) {
	const url = new URL(`https://test.invalid/api/record-recovery?${parameters}`);
	const request = new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.1' } });
	return GET({ request, url } as Parameters<typeof GET>[0]);
}

const scope = { city: 'demo', from: '2026-11-17', to: '2026-11-23', visitorIp: '192.0.2.1' };

it('re-reads only the selected Departure card and preserves its service day', async () => {
	const params = new URLSearchParams({
		...scope,
		screen: 'departure',
		id: JSON.stringify(['A/B', 1, '07:42:00']),
		page: 'day=2026-11-19',
		readings: 'sections.stops',
	});
	const response = await ask(params.toString());
	expect(await response.json()).toEqual({ 'sections.stops': { kind: 'busy' } });
	expect(engine.getRecordAnswer).toHaveBeenCalledExactlyOnceWith(
		{
			path: '/measure',
			parameters: {
				measure: 'punctuality',
				group: 'stop',
				line: 'A/B',
				direction: '1',
				departure: '07:42:00',
			},
		},
		{ ...scope, from: '2026-11-19', to: '2026-11-19' },
	);
});

it('reads only the missing Vehicle readings with the original cut and visitor', async () => {
	const response = await ask(
		'screen=vehicle&city=demo&id=101&from=2026-11-17&to=2026-11-23&readings=days',
	);
	expect(await response.json()).toEqual({ days: { kind: 'busy' } });
	expect(engine.getVehicleDayAnswers).not.toHaveBeenCalled();
	expect(engine.getRecordAnswer).toHaveBeenCalledExactlyOnceWith(
		{ path: '/measure', parameters: { measure: 'vehicles', group: 'day', vehicle: '101' } },
		scope,
	);
});

it('asks again on a screen that only waited before: Network health', async () => {
	const response = await ask(
		'screen=network&city=demo&from=2026-11-17&to=2026-11-23&readings=crowding,delayDistribution',
	);
	expect(await response.json()).toEqual({
		crowding: { kind: 'busy' },
		delayDistribution: { kind: 'busy' },
	});
	expect(engine.getRecordAnswer).toHaveBeenCalledExactlyOnceWith(
		{ path: '/measure', parameters: { measure: 'crowding' } },
		scope,
	);
	expect(engine.getDelayDistribution).toHaveBeenCalledExactlyOnceWith(scope);
});

it('keeps a Stop section in its place and asks the shared answer once', async () => {
	const response = await ask(
		'screen=stop&city=demo&id=S1&from=2026-11-17&to=2026-11-23&readings=sections.delay,network',
	);
	expect(await response.json()).toEqual({
		'sections.delay': { kind: 'busy' },
		network: { kind: 'busy' },
	});
	expect(engine.getRecordAnswer).toHaveBeenCalledTimes(2);
	expect(engine.getRecordAnswer).toHaveBeenCalledWith(
		{ path: '/measure', parameters: { measure: 'punctuality', stop: 'S1' } },
		scope,
		{ lead: true },
	);
});

it('brings the three stops’ names back with the Overview ranking', async () => {
	engine.getRanking.mockResolvedValueOnce({
		kind: 'answer',
		answer: { rows: [{ id: 'S2' }] },
	} as never);
	engine.getScheduleEdition.mockResolvedValueOnce({
		stops: [
			{ id: 'S1', name: 'One' },
			{ id: 'S2', name: 'Two' },
		],
	} as never);
	const response = await ask(
		'screen=overview&city=demo&from=2026-11-17&to=2026-11-23&readings=stops',
	);
	const body = await response.json();
	expect(body.directory).toEqual([{ id: 'S2', name: 'Two' }]);
	expect(engine.getRanking).toHaveBeenCalledTimes(1);
	expect(engine.getMeasure).not.toHaveBeenCalled();
});

it.each([
	'screen=atlas&city=demo&from=2026-11-17&to=2026-11-23&readings=a',
	'screen=line&city=demo&from=2026-11-17&to=2026-11-23&readings=crowding',
	'screen=network&city=demo&id=1&from=2026-11-17&to=2026-11-23&readings=crowding',
	'screen=network&city=demo&from=2026-11-17&to=2026-11-23&readings=a.b.c',
	'screen=network&city=Demo&from=2026-11-17&to=2026-11-23&readings=crowding',
	'screen=network&city=demo&from=2026-11-23&to=2026-11-17&readings=crowding',
])('refuses a malformed request: %s', async (parameters) => {
	expect((await ask(parameters)).status).toBe(400);
	expect(engine.getRecordAnswer).not.toHaveBeenCalled();
});
