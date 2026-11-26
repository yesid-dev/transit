import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { loadStopRecord } from '#lib/server/stopRecord.ts';

const harness = vi.hoisted(() => ({ getRecordAnswer: vi.fn() }));
const stop = {
	id: '1234',
	name: '  Van Horne / Rockland  ',
	code: '56789',
	lat: 45.51,
	lon: -73.62,
	routes: ['24'],
};
const schedule = { date: '2026-11-23', routes: [], stops: [stop] };

vi.mock('#lib/server/engine.ts', () => ({ getRecordAnswer: harness.getRecordAnswer }));

import { load } from './+page.server';

function event(
	id = '1234',
	href = `https://transit.yesid.dev/stop/${id}?tab=detail&frameMode=live`,
	options: { lang?: 'en' | 'fr'; schedule?: typeof schedule | null; v1?: boolean } = {},
): Parameters<typeof load>[0] {
	return {
		params: { id },
		url: new URL(href),
		fetch: vi.fn(),
		request: new Request(href, {
			headers: { 'cf-connecting-ip': '192.0.2.24' },
		}),
		locals: {},
		platform: undefined,
		parent: async () => ({
			v1: options.v1 === false ? null : { manifest: { provider: 'octranspo' } },
			lang: options.lang ?? 'en',
			schedule: options.schedule === undefined ? schedule : options.schedule,
			providerId: 'octranspo',
			routesIndex: { routes: [{ id: '24', short: '24', long: 'Sherbrooke' }] },
		}),
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	harness.getRecordAnswer.mockReset().mockResolvedValue({ kind: 'unconfigured' });
});

describe('/stop/[id] server identity seed', () => {
	it.each(['next', 'info', 'unknown', 'reliability'])(
		'redirects the noncanonical %s tab before fetching data and preserves unrelated params',
		async (tab) => {
			const request = event();
			Object.assign(request, {
				url: new URL(
					`https://transit.yesid.dev/stop/1234?tab=${tab}&from=2026-01-31&to=2026-02-01&line=51`,
				),
			});

			await expect(load(request)).rejects.toMatchObject({
				status: 308,
				location: '/stop/1234?from=2026-01-31&to=2026-02-01&line=51',
			});
			expect(request.fetch).not.toHaveBeenCalled();
		},
	);

	it('keeps an explicit Detail tab without redirecting', async () => {
		const request = event();
		Object.assign(request, {
			url: new URL('https://transit.yesid.dev/stop/1234?tab=detail&frameMode=live'),
		});

		await expect(load(request)).resolves.toMatchObject({ seed: { id: '1234' } });
		expect(request.fetch).not.toHaveBeenCalled();
	});

	it('seeds Live from the layout schedule without a second read', async () => {
		const request = event();
		expect(await load(request)).toMatchObject({
			seed: { id: '1234', name: 'Van Horne / Rockland' },
			seoTitle: 'Van Horne / Rockland (stop 56789)',
			stopSeed: {
				key: '1234',
				data: {
					id: '1234',
					code: '56789',
					routes_served: ['24'],
					generated_utc: '2026-11-23T00:00:00Z',
					scheduled: [],
				},
			},
		});
		expect(request.fetch).not.toHaveBeenCalled();
	});

	it('uses the stop ID when its name is blank', async () => {
		const request = event(undefined, undefined, {
			schedule: { ...schedule, stops: [{ ...stop, name: '   ' }] },
		});
		expect(await load(request)).toMatchObject({
			seed: { id: '1234', name: '1234' },
			stopSeed: { key: '1234', data: { id: '1234', name: '   ' } },
		});
	});

	it('seeds a known missing stop without a second read', async () => {
		const request = event('9999');
		expect(await load(request)).toMatchObject({
			seed: { id: '9999', name: '9999' },
			stopSeed: { key: '9999', data: null },
		});
		expect(request.fetch).not.toHaveBeenCalled();
	});

	it('leaves the live stop unseeded when schedule-index is unavailable', async () => {
		expect(await load(event('5678', undefined, { schedule: null }))).toMatchObject({
			seed: { id: '5678', name: '5678' },
			stopSeed: null,
		});
	});
});

it.each(['en', 'fr'] as const)('titles from the selected schedule stop in %s', async (lang) => {
	expect(await load(event(undefined, undefined, { lang }))).toMatchObject({
		seoTitle: 'Van Horne / Rockland (' + (lang === 'en' ? 'stop' : 'arrêt') + ' 56789)',
	});
});

it('omits seoTitle without a live context', async () => {
	expect(await load(event(undefined, undefined, { v1: false }))).not.toHaveProperty('seoTitle');
});

it('streams the dated stop cuts without waiting for a slow per-line answer', async () => {
	const request = event(
		'S1',
		'https://transit1.yesid.dev/fr/stop/S1?recordFrom=2026-10-20&recordTo=2026-10-21',
	);
	const result = { kind: 'answer', answer: { value: { on_time: 0.8 } } };
	harness.getRecordAnswer.mockResolvedValueOnce(result);
	const slow = new Promise(() => {});
	harness.getRecordAnswer.mockReturnValueOnce(slow);
	const data = await load(request);
	const record: ReturnType<typeof loadStopRecord> | undefined = data?.record;
	const sections = new Map(record?.sections.map(({ section, answer }) => [section, answer]));
	await expect(sections.get('punctuality')).resolves.toMatchObject(result);
	expect(sections.get('byLine')).toBe(slow);
	await expect(sections.get('waiting')).resolves.toEqual({ kind: 'unconfigured' });
	expect(sections.get('delay')).toBe(sections.get('punctuality'));
	expect(harness.getRecordAnswer.mock.calls.slice(0, 7)).toEqual(
		[
			{ measure: 'punctuality' },
			{ measure: 'on_time', group: 'line' },
			{ measure: 'waiting_and_gaps', group: 'line' },
			{ measure: 'on_time', group: 'hour' },
			{ measure: 'on_time', group: 'day' },
			{ measure: 'accessible_stops' },
			{ measure: 'alert_counts' },
		].map((parameters) => [
			{ path: '/measure', parameters: { ...parameters, stop: 'S1' } },
			{
				city: 'octranspo',
				from: '2026-10-20',
				to: '2026-10-21',
				preset: null,
				visitorIp: '192.0.2.24',
			},
		]),
	);
	expect(harness.getRecordAnswer.mock.calls.slice(7).map(([query]) => query)).toEqual([
		{ path: '/measure', parameters: { measure: 'late', group: 'weekday_hour', stop: 'S1' } },
		{ path: '/measure', parameters: { measure: 'on_time' } },
		{ path: '/measure', parameters: { measure: 'on_time', group: 'day' } },
	]);
});

it('keeps Live on the existing stop data without starting a Record query', async () => {
	const request = event('S1', 'https://transit1.yesid.dev/stop/S1?frameMode=live');
	await expect(load(request)).rejects.toMatchObject({
		status: 307,
		location: '/stop/S1?frameMode=live&tab=detail',
	});
	request.url.searchParams.set('tab', 'detail');
	await expect(load(request)).resolves.toMatchObject({ frameLive: true, seed: { id: 'S1' } });
	expect(harness.getRecordAnswer).not.toHaveBeenCalled();
});
