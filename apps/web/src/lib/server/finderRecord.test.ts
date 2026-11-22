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

it('leaves an unframed listing on the existing surface', async () => {
	fetcher.mockReset();
	const event = {
		url: new URL('https://transit.yesid.dev/stops?q=Fixture'),
		request: new Request('https://transit.yesid.dev/stops'),
		parent: async () => ({ providerId: 'test-network' }),
	};
	expect(await loadStops(event as Parameters<typeof loadStops>[0])).toEqual({ finderRecord: null });
	expect(fetcher).not.toHaveBeenCalled();
});
