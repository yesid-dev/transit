import { afterEach, expect, it, vi } from 'vitest';
import { load as overview } from '../../routes/[[lang=locale]]/+page.server.ts';
import { load as alerts } from '../../routes/[[lang=locale]]/alerts/+page.server.ts';
import { load as rankings } from '../../routes/[[lang=locale]]/rankings/+page.server.ts';
import { load as lines } from '../../routes/[[lang=locale]]/lines/+page.server.ts';
import { load as methods } from '../../routes/[[lang=locale]]/metrics/+page.server.ts';
import { load as network } from '../../routes/[[lang=locale]]/network/+page.server.ts';
import { load as daily } from '../../routes/[[lang=locale]]/receipt/+page.server.ts';
import { load as health } from '../../routes/[[lang=locale]]/status/+page.server.ts';
import { load as stops } from '../../routes/[[lang=locale]]/stops/+page.server.ts';
import { warmQuestions } from '../../../scripts/warm-default-views.ts';
import { defaultCityQuestions, defaultPeriod, sharedDefaultQuestion } from './defaultQuestions.ts';
import { frameClock } from '#lib/site/frameState.ts';
import { getScheduleEdition } from './engine.ts';
import { GET as mapRecord } from '../../routes/api/map-record/+server.ts';

const { fetcher } = vi.hoisted(() => ({
	fetcher: vi.fn(async (_request: Request) => new Response(null, { status: 503 })),
}));
vi.mock('cloudflare:workers', () => ({ env: { QUESTION_PROXY: { fetch: fetcher } } }));

afterEach(() => {
	vi.useRealTimers();
	fetcher.mockClear();
});

it.each([
	{
		id: 'fixture-north',
		timezone: 'America/Toronto',
		record_through: '2026-11-20',
		inputs: { i3_alerts: true, service_alerts: false },
	},
	{
		id: 'fixture-south',
		timezone: 'America/Los_Angeles',
		record_through: '2026-11-19',
		inputs: { i3_alerts: false, service_alerts: false },
	},
])('warms the same questions that the default screens request for $id', async (provider) => {
	vi.useFakeTimers({ toFake: ['Date'] });
	const now = new Date('2026-11-22T06:30:00Z');
	vi.setSystemTime(now);
	const period = defaultPeriod(frameClock(provider, now))!;
	expect(period).toMatchObject(
		provider.id === 'fixture-north'
			? { from: '2026-11-14', to: '2026-11-20' }
			: { from: '2026-11-13', to: '2026-11-19' },
	);
	const origin = 'https://transit1.yesid.dev';
	const request = new Request(origin);
	const label = { city: 'Fixture', operator: 'Fixture' };
	const parent = async () => ({
		providerId: provider.id,
		provider: { ...provider, labels: { en: label, fr: label }, alert_links: {} },
		lang: 'en',
	});
	const captureFetch = vi.fn(async () => new Response(null, { status: 503 }));
	const visit = <T>(load: (event: T) => unknown, path: string) =>
		load({
			url: new URL(path, origin),
			request,
			parent,
			params: {},
			fetch: captureFetch,
			locals: { overviewSchedule: null },
		} as T);
	const receipt = '/receipt?frameMode=record&recordFrom=' + period.to + '&recordTo=' + period.to;
	await Promise.all([
		visit(overview, '/'),
		visit(lines, '/lines'),
		visit(stops, '/stops'),
		visit(rankings, '/rankings'),
		visit(rankings, '/rankings?kind=stop'),
		visit(rankings, '/rankings?kind=departure'),
		visit(rankings, '/rankings?kind=vehicle'),
		visit(daily, receipt),
		visit(network, '/network'),
		visit(alerts, '/alerts'),
		visit(health, '/status'),
		visit(health, '/status?frameMode=live'),
		visit(methods, '/metrics'),
		getScheduleEdition(provider.id),
		...['', '&layer=corridors'].map((layer) =>
			mapRecord({
				url: new URL(
					`/api/map-record?${new URLSearchParams({ city: provider.id, from: period.from, to: period.to })}${layer}`,
					origin,
				),
				request,
			} as Parameters<typeof mapRecord>[0]),
		),
	]);
	const visitor = fetcher.mock.calls.map(([request]) => {
		const url = new URL(request.url);
		url.searchParams.sort();
		return url.href;
	});
	const warm = [...defaultCityQuestions(provider, period), sharedDefaultQuestion];
	expect(captureFetch).toHaveBeenCalledExactlyOnceWith(
		`/api/live?city=${provider.id}`,
		expect.anything(),
	);
	expect(warm.toSorted()).toEqual([...new Set(visitor)].toSorted());
	expect(warm.length).toBeLessThan(visitor.length);
});

it('does not start Record questions for an unpublished Yesterday', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-25T05:30:00Z'));
	const url = new URL(
		'https://transit1.yesid.dev/lines?period=yesterday&recordFrom=2026-11-24&recordTo=2026-11-24',
	);
	const request = new Request(url);
	const parent = async () => ({
		providerId: 'fixture',
		provider: { timezone: 'America/Toronto', record_through: '2026-11-23' },
	});
	const result = await lines({ url, request, parent } as Parameters<typeof lines>[0]);
	expect(result.finderRecord).toBeNull();
	expect(fetcher).not.toHaveBeenCalled();
});

it('warms the same ranges and questions overnight and in the afternoon on the same edition', () => {
	const city = {
		id: 'fixture',
		timezone: 'America/Toronto',
		inputs: { i3_alerts: true },
		record_through: '2026-11-23',
	};
	const at = (utc: string) => {
		const now = new Date(utc);
		const period = defaultPeriod(frameClock(city, now))!;
		return { period, questions: defaultCityQuestions(city, period) };
	};
	const overnight = at('2026-11-25T05:30:00Z');
	expect(overnight.period).toMatchObject({ from: '2026-11-17', to: '2026-11-23' });
	expect(at('2026-11-25T18:00:00Z')).toEqual(overnight);
	expect(
		overnight.questions
			.map((url) => new URL(url))
			.find(({ pathname }) => pathname === '/v2/fixture/data-health')
			?.searchParams.get('to'),
	).toBe('2026-11-23');
});

it.each([
	[400, { message: 'unknown parameter' }],
	[409, { reason: 'segment_runs_version_required' }],
])('asks the visitor to choose a line when the engine returns %i', async (status, payload) => {
	fetcher.mockResolvedValueOnce(Response.json(payload, { status }));
	const url = new URL(
		'https://example.test/api/map-record?city=fixture&from=2026-11-15&to=2026-11-21&layer=corridors',
	);
	const response = await mapRecord({ url, request: new Request(url) } as Parameters<
		typeof mapRecord
	>[0]);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ state: 'choose_line' });
	expect(new URL(fetcher.mock.calls.at(-1)![0].url).searchParams.get('line')).toBeNull();
});

it('keeps the source date in the network corridor response', async () => {
	const evidence = { days_not_measured: [], source_date: '2026-11-20' };
	fetcher.mockResolvedValueOnce(
		Response.json({
			measure: 'mean_time_lost',
			from_stop: ['A'],
			to_stop: ['B'],
			lines: [['1']],
			value: [5],
			sample: [25],
			state: [3],
			evidence,
		}),
	);
	const url = new URL(
		'https://example.test/api/map-record?city=fixture&from=2026-11-15&to=2026-11-21&layer=corridors',
	);
	const response = await mapRecord({ url, request: new Request(url) } as Parameters<
		typeof mapRecord
	>[0]);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ evidence });
});

it('stays under 30 starts per rolling minute and waits for slow responses', async () => {
	let clock = 0;
	const starts: number[] = [];
	const urls = Array.from({ length: 64 }, (_, index) => `https://example.test/v2/${index}`);
	const { requests } = await warmQuestions(urls, {
		now: () => clock,
		wait: async (ms) => void (clock += ms ?? 0),
		fetcher: async (url) => {
			starts.push(clock);
			const index = urls.indexOf(String(url));
			if (index === 0) {
				clock += 5_000;
				return Response.json({});
			}
			if (index === 1) return new Response(null, { status: 503, headers: { 'Retry-After': '60' } });
			if (index === 2) return Response.json({}, { headers: { 'X-Transit-Answer': 'last-good' } });
			if (index === 3) throw new Error('connection error');
			if (index === 4)
				return Response.json({ reason: 'segment_runs_version_required' }, { status: 409 });
			if (index === 5) return Response.json({ reason: 'segment_runs_missing' }, { status: 409 });
			if (index === 6)
				return Response.json({ reason: 'delay_distribution_unsupported' }, { status: 409 });
			return Response.json({});
		},
	});
	expect(starts[1]).toBe(5_000);
	for (const start of starts) {
		expect(starts.filter((time) => time >= start && time < start + 60_000).length).toBeLessThan(30);
	}
	expect(requests.slice(0, 7).map(({ outcome }) => outcome)).toEqual([
		'answered',
		'busy',
		'failed',
		'failed',
		'deferred',
		'failed',
		'deferred',
	]);
	expect(requests).toHaveLength(urls.length);
});
