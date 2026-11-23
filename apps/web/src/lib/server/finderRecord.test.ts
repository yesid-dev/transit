import { expect, it, vi } from 'vitest';
import { load as loadLines } from '../../routes/[[lang=locale]]/lines/+page.server.ts';
import { load as loadStops } from '../../routes/[[lang=locale]]/stops/+page.server.ts';

const { fetcher } = vi.hoisted(() => ({
	fetcher: vi.fn<(request: Request) => Promise<Response>>(),
}));
vi.mock('cloudflare:workers', () => ({ env: { QUESTION_PROXY: { fetch: fetcher } } }));

it('streams complete groups for the selected city and period through the service binding', async () => {
	fetcher.mockReset();
	const answer = {
		evidence: {
			start_date: '2026-10-17',
			end_date: '2026-10-18',
			days_included: ['2026-10-17'],
			days_measured: ['2026-10-17'],
			days_not_measured: ['2026-10-18'],
			cleaning_versions: [8],
			method_version: 'finder-fixture',
			query_ms: 2,
		},
		coverage_note: null,
		cells: [],
	};
	fetcher.mockImplementation(async () => Response.json(answer));
	const event = (path: string) => ({
		url: new URL(`https://transit1.yesid.dev/fr/${path}?recordFrom=2026-10-17&recordTo=2026-10-18`),
		request: new Request('https://transit1.yesid.dev', {
			headers: { 'cf-connecting-ip': '192.0.2.1' },
		}),
		parent: async () => ({ providerId: 'test-network' }),
	});
	const lines = await loadLines(event('lines') as Parameters<typeof loadLines>[0]);
	const stops = await loadStops(event('stops') as Parameters<typeof loadStops>[0]);
	expect(lines.finderRecord?.period).toEqual({
		from: '2026-10-17',
		to: '2026-10-18',
		preset: null,
	});
	for (const section of [
		lines.finderRecord?.punctuality,
		lines.finderRecord?.trips,
		stops.finderRecord?.punctuality,
	]) {
		expect(section).toBeInstanceOf(Promise);
		expect(await section).toEqual({ kind: 'answer', answer });
	}
	expect(fetcher.mock.calls.map(([request]) => request.url)).toEqual([
		'https://data.yesid.dev/v2/test-network/measure?from=2026-10-17&to=2026-10-18&measure=on_time&group=line',
		'https://data.yesid.dev/v2/test-network/measure?from=2026-10-17&to=2026-10-18&measure=trips_run&group=line',
		'https://data.yesid.dev/v2/test-network/measure?from=2026-10-17&to=2026-10-18&measure=on_time&group=stop_id',
	]);
	expect(
		fetcher.mock.calls.every(
			([request]) => request.headers.get('x-transit-visitor-ip') === '192.0.2.1',
		),
	).toBe(true);
});

it('uses the default Record period for bare finders on a local host', async () => {
	vi.useFakeTimers();
	try {
		vi.setSystemTime(new Date('2026-11-23T15:00:00Z'));
		fetcher.mockReset().mockImplementation(async () => new Response(null, { status: 503 }));
		const event = (path: string) => ({
			url: new URL(`http://127.0.0.1:4317/${path}?q=Fixture`),
			request: new Request('http://127.0.0.1:4317'),
			parent: async () => ({ providerId: 'test-network' }),
		});
		const lines = await loadLines(event('lines') as Parameters<typeof loadLines>[0]);
		const stops = await loadStops(event('stops') as Parameters<typeof loadStops>[0]);
		const period = { from: '2026-11-16', to: '2026-11-22', preset: '7-days' };
		expect(lines.finderRecord?.period).toEqual(period);
		expect(stops.finderRecord?.period).toEqual(period);
		expect(fetcher.mock.calls.map(([request]) => request.url)).toEqual([
			'https://data.yesid.dev/v2/test-network/measure?from=2026-11-16&to=2026-11-22&measure=on_time&group=line',
			'https://data.yesid.dev/v2/test-network/measure?from=2026-11-16&to=2026-11-22&measure=trips_run&group=line',
			'https://data.yesid.dev/v2/test-network/measure?from=2026-11-16&to=2026-11-22&measure=on_time&group=stop_id',
		]);
	} finally {
		vi.useRealTimers();
	}
});
