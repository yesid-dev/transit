import { afterEach, expect, it, vi } from 'vitest';
import { load as overview } from '../../routes/[[lang=locale]]/+page.server.ts';
import { load as alerts } from '../../routes/[[lang=locale]]/alerts/+page.server.ts';
import { load as hotspots } from '../../routes/[[lang=locale]]/hotspots/+page.server.ts';
import { load as lines } from '../../routes/[[lang=locale]]/lines/+page.server.ts';
import { load as methods } from '../../routes/[[lang=locale]]/metrics/+page.server.ts';
import { load as network } from '../../routes/[[lang=locale]]/network/+page.server.ts';
import { load as daily } from '../../routes/[[lang=locale]]/receipt/+page.server.ts';
import { load as repeatOffenders } from '../../routes/[[lang=locale]]/repeat-offenders/+page.server.ts';
import { load as health } from '../../routes/[[lang=locale]]/status/+page.server.ts';
import { load as stops } from '../../routes/[[lang=locale]]/stops/+page.server.ts';
import { warmQuestions } from '../../../scripts/warm-default-views.ts';
import { defaultCityQuestions, defaultPeriod, sharedDefaultQuestion } from './defaultQuestions.ts';
import { getScheduleEdition } from './engine.ts';

const { fetcher } = vi.hoisted(() => ({
	fetcher: vi.fn(async (_request: Request) => new Response(null, { status: 503 })),
}));
vi.mock('cloudflare:workers', () => ({ env: { QUESTION_PROXY: { fetch: fetcher } } }));

afterEach(() => {
	vi.useRealTimers();
	fetcher.mockClear();
});

it.each([
	{ id: 'fixture-north', inputs: { i3_alerts: true, service_alerts: false } },
	{ id: 'fixture-south', inputs: { i3_alerts: false, service_alerts: false } },
])('warms the same questions that the default screens request for $id', async (provider) => {
	vi.useFakeTimers({ toFake: ['Date'] });
	const now = new Date('2026-11-23T02:00:00Z');
	vi.setSystemTime(now);
	const period = defaultPeriod(now)!;
	expect(period).toMatchObject({ from: '2026-11-15', to: '2026-11-21' });
	const origin = 'https://transit1.yesid.dev';
	const request = new Request(origin);
	const label = { city: 'Fixture', operator: 'Fixture' };
	const parent = async () => ({
		providerId: provider.id,
		provider: { ...provider, labels: { en: label, fr: label }, alert_links: {} },
		lang: 'en',
	});
	const visit = <T>(load: (event: T) => unknown, path: string) =>
		load({ url: new URL(path, origin), request, parent } as T);
	await Promise.all([
		visit(overview, '/'),
		visit(lines, '/lines'),
		visit(stops, '/stops'),
		visit(hotspots, '/hotspots'),
		visit(hotspots, '/hotspots?kind=stop'),
		visit(repeatOffenders, '/repeat-offenders'),
		visit(repeatOffenders, '/repeat-offenders?kind=vehicle'),
		visit(daily, '/receipt'),
		visit(network, '/network'),
		visit(alerts, '/alerts'),
		visit(health, '/status'),
		visit(methods, '/metrics'),
		getScheduleEdition(provider.id),
	]);
	const visitor = fetcher.mock.calls.map(([request]) => {
		const url = new URL(request.url);
		url.searchParams.sort();
		return url.href;
	});
	const warm = [...defaultCityQuestions(provider, period), sharedDefaultQuestion];
	expect(warm.toSorted()).toEqual([...new Set(visitor)].toSorted());
	expect(warm.length).toBeLessThan(visitor.length);
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
			return Response.json({});
		},
	});
	expect(starts[1]).toBe(5_000);
	for (const start of starts) {
		expect(starts.filter((time) => time >= start && time < start + 60_000).length).toBeLessThan(30);
	}
	expect(requests.slice(0, 5).map(({ outcome }) => outcome)).toEqual([
		'answered',
		'busy',
		'failed',
		'failed',
		'answered',
	]);
	expect(requests).toHaveLength(urls.length);
});
