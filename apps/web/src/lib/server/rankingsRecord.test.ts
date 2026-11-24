import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadRankingsRecord, rankingsCsv } from './rankingsRecord.ts';
import type { RankingPath } from '#lib/features/rankings/rankingSelection.ts';

const { fetcher } = vi.hoisted(() => ({
	fetcher: vi.fn<(request: Request) => Promise<Response>>(),
}));
vi.mock('cloudflare:workers', () => ({ env: { QUESTION_PROXY: { fetch: fetcher } } }));

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-22T19:00:00Z'));
	fetcher.mockReset();
});
afterEach(() => vi.useRealTimers());

const dates = 'recordFrom=2026-10-15&recordTo=2026-11-21';

it.each([
	['/hotspots', '', { kind: 'line', measure: 'on_time' }],
	['/hotspots', 'class=all&measure=late', { kind: 'line', measure: 'late', class: 'all' }],
	['/hotspots', 'class=3%3Afrequent', { kind: 'line', measure: 'on_time', class: '3:frequent' }],
	['/hotspots', 'kind=stops&class=all&measure=missing_trips', { kind: 'stop', measure: 'on_time' }],
	['/repeat-offenders', '', { kind: 'departure', measure: 'on_time' }],
	[
		'/repeat-offenders',
		'kind=buses&measure=late',
		{ kind: 'vehicle', measure: 'vehicle_reporting_gaps_per_100_hours' },
	],
] as const)('streams the engine query for %s?%s', async (path: RankingPath, query, cuts) => {
	let finish!: (response: Response) => void;
	fetcher.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const url = new URL(`https://transit1.yesid.dev${path}?${dates}&${query}`);
	const record = await loadRankingsRecord(path, {
		url,
		request: new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.24' } }),
		parent: async () => ({ providerId: 'agency' }),
	});
	expect(record.answer).toBeInstanceOf(Promise);
	expect(record.period).toMatchObject({ from: '2026-10-15', to: '2026-11-21' });
	const request = fetcher.mock.calls[0]![0];
	const requested = new URL(request.url);
	expect(requested.pathname).toBe('/v2/agency/ranking');
	expect(Object.fromEntries(requested.searchParams)).toEqual({
		from: '2026-10-15',
		to: '2026-11-21',
		limit: '500',
		...cuts,
	});
	expect(request.headers.get('x-transit-visitor-ip')).toBe('192.0.2.24');
	finish(new Response(null, { status: 503, headers: { 'retry-after': '1' } }));
	expect(await record.answer).toEqual({ kind: 'busy' });
});

const city = {
	id: 'agency',
	timezone: 'America/Los_Angeles',
	labels: {
		en: { city: 'Agency', operator: 'Agency' },
		fr: { city: 'Agency', operator: 'Agency' },
	},
	bounds: null,
	alert_links: {},
	inputs: {},
	lines_without_live_data: [],
};
const catalog = () => Response.json({ default_provider: city.id, providers: [city] });

it('rejects a CSV period that has not started in the selected city', async () => {
	vi.setSystemTime(new Date('2026-11-22T06:30:00Z'));
	const url = new URL(
		'https://transit1.yesid.dev/hotspots/record.csv?provider=agency&recordFrom=2026-11-22&recordTo=2026-11-22',
	);
	fetcher.mockResolvedValueOnce(catalog());
	await expect(rankingsCsv('/hotspots', url, new Request(url), 'en')).rejects.toMatchObject({
		status: 400,
	});
	expect(fetcher).toHaveBeenCalledTimes(1);
});

it('forwards the same cuts and locale to the engine CSV and streams its bytes', async () => {
	const url = new URL(
		`https://transit1.yesid.dev/fr/hotspots/record.csv?provider=agency&${dates}&class=all&measure=median_delay`,
	);
	fetcher
		.mockResolvedValueOnce(catalog())
		.mockResolvedValue(
			new Response('Rang,Type\n1,line\n', { headers: { 'content-type': 'text/csv' } }),
		);
	const response = await rankingsCsv('/hotspots', url, new Request(url), 'fr');
	const request = new URL(fetcher.mock.calls[1]![0].url);
	expect(Object.fromEntries(request.searchParams)).toEqual({
		from: '2026-10-15',
		to: '2026-11-21',
		kind: 'line',
		measure: 'median_delay',
		class: 'all',
		limit: '500',
		format: 'csv',
		lang: 'fr',
	});
	expect(response.headers.get('content-disposition')).toBe(
		'attachment; filename="rankings-line.csv"',
	);
	expect(await response.text()).toBe('Rang,Type\n1,line\n');
});
