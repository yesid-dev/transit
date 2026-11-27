import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
	ctx: { fetch: vi.fn(), providerId: 'octranspo', manifest: { provider: 'octranspo' } },
	getRoute: vi.fn(),
	getRecordAnswer: vi.fn(),
}));

vi.mock('#lib/server/engine.ts', () => ({ getRecordAnswer: harness.getRecordAnswer }));

vi.mock('#lib/v1/repositories/static.ts', () => ({
	getRoute: (...args: unknown[]) => harness.getRoute(...args),
}));

import { render, waitFor } from '@testing-library/svelte';
import LineScheduleCard from '#lib/features/lines/LineScheduleCard.svelte';
import { plannedInterval, towardReading } from '#lib/site/presenter.ts';
import { load } from './+page.server';

function event(id = '24'): Parameters<typeof load>[0] {
	return {
		params: { id },
		url: new URL(`https://transit.yesid.dev/lines/${id}`),
		fetch: vi.fn(),
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
	});

	it('keeps old live addresses and only reads the selected mode', async () => {
		await expect(load(framed('&tab=detail'))).rejects.toMatchObject({
			status: 308,
			location: `/lines/24?${dates}&frameMode=live`,
		});
		expect(harness.getRecordAnswer).not.toHaveBeenCalled();
	});

	it('loads historical readings for a line outside the current timetable', async () => {
		const request = framed('&frameMode=record');
		request.params.id = 'seasonal';
		const data = await load(request);
		expect(data?.outsideCurrentTimetable).toBe(true);
		expect(data?.record?.line).toBe('seasonal');
		expect(harness.getRecordAnswer).toHaveBeenCalledWith(
			{
				path: '/measure',
				parameters: { measure: 'punctuality', group: 'stop', line: 'seasonal' },
			},
			expect.objectContaining({ from: '2026-11-08', to: '2026-11-14' }),
		);
		expect(request.fetch).not.toHaveBeenCalled();
	});

	it('returns a Live state for a line outside the current timetable without asking for readings', async () => {
		const request = framed('&frameMode=live');
		request.params.id = 'seasonal';
		await expect(load(request)).resolves.toMatchObject({
			frameLive: true,
			outsideCurrentTimetable: true,
			capture: null,
			trips: null,
			record: null,
		});
		expect(request.fetch).not.toHaveBeenCalled();
		expect(harness.getRecordAnswer).not.toHaveBeenCalled();
	});
});

describe('Line Live Schedule card', () => {
	const weekday = {
		period_text: { en: 'Morning peak', fr: 'Pointe du matin' },
		start_hour: 6,
		end_hour: 9,
		day_type: 'weekday',
		days: 5,
		scheduled_trips: 105,
		scheduled_clock_hours: 15,
		scheduled_frequency: 7,
	};
	const measured = { state: 'measured', state_text: { en: '', fr: '' } };
	const evidence = { counts: {}, days_included: ['2026-11-09'] };
	const toward = (rate: number) => ({ ...weekday, scheduled_frequency: rate });

	beforeEach(() => {
		harness.getRecordAnswer.mockImplementation(async ({ parameters }) => {
			if (parameters.measure === 'scheduled_frequency' && parameters.group === 'direction')
				return {
					kind: 'answer',
					answer: {
						coverage_note: null,
						evidence,
						cells: [0, 1].map((direction) => ({
							...measured,
							key: { direction },
							value: {},
							evidence: { ...evidence, periods: [toward(direction === 0 ? 4 : 3)] },
						})),
					},
				};
			if (parameters.measure === 'scheduled_frequency')
				return {
					kind: 'answer',
					answer: {
						...measured,
						coverage_note: null,
						value: { scheduled_frequency: 7 },
						evidence: { ...evidence, periods: [weekday] },
					},
				};
			if (parameters.measure === 'service_delivered')
				return { kind: 'answer', answer: { coverage_note: null, evidence, cells: [] } };
			return { kind: 'unconfigured' };
		});
	});

	it.each(['en', 'fr'] as const)(
		'reads the planned frequency toward the busier terminus (%s)',
		async (locale) => {
			const url = new URL(
				'https://transit1.yesid.dev/lines/24?recordFrom=2026-11-08&recordTo=2026-11-14&frameMode=live',
			);
			const request = event('24');
			Object.assign(request, { url });
			const data = await load(request);
			const { container } = render(LineScheduleCard, {
				record: data!.record!,
				locale,
				url,
				headsigns: { 0: 'Tunney’s Pasture', 1: 'Blair' },
			});
			const expected = `${plannedInterval(4, locale)} ${towardReading('Tunney’s Pasture', locale, undefined, false)}`;
			await waitFor(() =>
				expect(container.querySelector('#frequency')).toHaveTextContent(expected),
			);
			expect(container.querySelector('#frequency')).not.toHaveTextContent(
				locale === 'fr' ? 'Inconnu' : 'Unknown',
			);
		},
	);
});
