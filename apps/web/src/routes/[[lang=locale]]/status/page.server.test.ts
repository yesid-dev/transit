import { afterEach, expect, it, vi } from 'vitest';

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
				lang: 'en',
				provider: { inputs: { i3_alerts: false, service_alerts: false }, alert_links: {} },
				v1: { manifest: { provider: 'stm' } },
			}),
		} as unknown as Parameters<typeof load>[0]);
		expect(data?.view).toBe(mode);
		if (data?.view === 'live') {
			expect(await data.capture).toMatchObject({ city: 'stm', version: 2 });
		}
		if (data?.view === 'record' && data.record) {
			expect(await data.record.methods).toEqual({ kind: 'answer', answer: [] });
			expect(await data.record.health).toEqual({ kind: 'busy', retryAfterMs: 30_000 });
			expect(await data.record.coverage).toEqual({ kind: 'busy', retryAfterMs: 30_000 });
			expect(await data.record.deliveryDays).toEqual({
				kind: 'busy',
				retryAfterMs: 30_000,
			});
			await Promise.all([data.record.accessibility, ...Object.values(data.record.scorecard)]);
			// Alerts are not collected for this fixture, so no alert question is asked.
			expect(data.record.alertEffects).toBeNull();
		}
		expect(ports.bucket).not.toHaveBeenCalled();
		expect(ports.legacy).not.toHaveBeenCalled();
		expect(appFetch.mock.calls.map(([input]) => String(input))).toEqual(
			mode === 'live' ? ['/api/live?city=stm'] : [],
		);
		const questions = ports.engine.mock.calls.map(([request]) => {
			const question = new URL(request.url);
			question.searchParams.delete('from');
			question.searchParams.delete('to');
			question.searchParams.sort();
			return question.pathname + question.search;
		});
		expect(questions.sort()).toEqual(
			mode === 'live'
				? ['/v2/stm/live']
				: [
						'/v2/how-we-measure',
						'/v2/stm/data-health',
						'/v2/stm/measure?group=day&measure=service_delivered',
						'/v2/stm/measure?measure=accessible_trips',
						'/v2/stm/measure?measure=feed_age_at_capture',
						'/v2/stm/measure?measure=live_trip_coverage',
						'/v2/stm/measure?measure=poll_success',
						'/v2/stm/measure?measure=prediction_error',
						'/v2/stm/measure?measure=punctuality',
						'/v2/stm/measure?measure=vehicle_field_completeness',
					],
		);
	},
);

afterEach(() => vi.useRealTimers());

it('reads the same last complete days as every other screen', async () => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ['Date'] });
	// 26 November in Montréal; the newest built day is 24 November.
	vi.setSystemTime(new Date('2026-11-26T15:00:00Z'));
	ports.engine.mockImplementation(
		async () => new Response(null, { status: 503, headers: { 'retry-after': '30' } }),
	);
	const url = new URL('https://transit.yesid.dev/status?provider=stm&frameMode=record');
	const data = await load({
		url,
		request: new Request(url),
		fetch: vi.fn(),
		locals: {},
		parent: async () => ({
			providerId: 'stm',
			lang: 'fr',
			provider: {
				timezone: 'America/Toronto',
				record_through: '2026-11-24',
				inputs: { service_alerts: true },
				alert_links: {},
			},
		}),
	} as unknown as Parameters<typeof load>[0]);
	if (data?.view !== 'record' || !data.record) throw new Error('Expected the Record view');
	await Promise.all([
		data.record.coverage,
		data.record.health,
		data.record.accessibility,
		data.record.deliveryDays,
		data.record.alertEffects,
		...Object.values(data.record.scorecard),
	]);
	expect(data.record.period).toEqual({
		from: '2026-11-18',
		to: '2026-11-24',
	});
	const asked = ports.engine.mock.calls.map(([request]) => new URL(request.url));
	expect(asked.length).toBeGreaterThan(0);
	for (const question of asked.filter(({ pathname }) => pathname !== '/v2/how-we-measure'))
		expect([question.searchParams.get('from'), question.searchParams.get('to')]).toEqual([
			'2026-11-18',
			'2026-11-24',
		]);
	// A city whose alerts Transit collects also asks which effects its alerts state.
	expect(asked.some((question) => question.searchParams.get('group') === 'effect')).toBe(true);
});
