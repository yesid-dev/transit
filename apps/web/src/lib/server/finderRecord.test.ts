import { expect, it, vi } from 'vitest';
import { load as loadLines } from '../../routes/[[lang=locale]]/lines/+page.server.ts';
import { load as loadStops } from '../../routes/[[lang=locale]]/stops/+page.server.ts';

const { fetcher } = vi.hoisted(() => ({
	fetcher: vi.fn<(request: Request) => Promise<Response>>(),
}));
vi.mock('cloudflare:workers', () => ({ env: { QUESTION_PROXY: { fetch: fetcher } } }));

it('reads complete finder groups and streams only the displayed Stops readings', async () => {
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
	const schedule = {
		date: '2026-10-18',
		routes: [],
		stops: Array.from({ length: 21 }, (_, index) => ({
			id: `S${index + 1}`,
			name: `Stop ${index + 1}`,
			lat: 45.5,
			lon: -73.6,
		})),
	};
	const stopCells = ['S1', 'S21'].map((stop) => ({
		key: { stop },
		value: { on_time: 0.8 },
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		evidence: { counts: { classified: 100 } },
	}));
	fetcher.mockImplementation(async (request) =>
		Response.json(
			new URL(request.url).searchParams.get('group') === 'stop_id'
				? { ...answer, cells: stopCells }
				: answer,
		),
	);
	const event = (path: string) => ({
		url: new URL(`https://transit1.yesid.dev/fr/${path}?recordFrom=2026-10-17&recordTo=2026-10-18`),
		request: new Request('https://transit1.yesid.dev', {
			headers: { 'cf-connecting-ip': '192.0.2.1' },
		}),
		parent: async () => ({ providerId: 'test-network', lang: 'fr' }),
		locals: { stopsSchedule: schedule },
	});
	const lines = await loadLines(event('lines') as Parameters<typeof loadLines>[0]);
	const stops = await loadStops(event('stops') as Parameters<typeof loadStops>[0]);
	expect(lines.finderRecord?.period).toEqual({
		from: '2026-10-17',
		to: '2026-10-18',
		preset: null,
	});
	for (const section of [lines.finderRecord?.punctuality, lines.finderRecord?.trips]) {
		expect(section).toBeInstanceOf(Promise);
		expect(await section).toEqual({ kind: 'answer', answer });
	}
	expect(stops.listing?.total).toBe(21);
	expect(stops.listing?.rows).toHaveLength(20);
	expect(stops.finderRecord?.punctuality).toBeInstanceOf(Promise);
	expect(await stops.finderRecord?.punctuality).toEqual({
		kind: 'answer',
		answer: { ...answer, cells: [stopCells[0]] },
		totals: { counts: { classified: 200 }, observed: null },
	});
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
			parent: async () => ({ providerId: 'test-network', lang: 'en' }),
			locals: { stopsSchedule: null },
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
