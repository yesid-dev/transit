import { csvText } from '../../tests/csv.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadRankingsRecord, rankingHeadsigns, rankingsCsv } from './rankingsRecord.ts';
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

it('keeps published destinations only when a direction has a single destination', () => {
	expect(
		rankingHeadsigns([
			{ dir: 0, headsign: 'East terminus' },
			{ dir: 0, headsign: 'University' },
			{ dir: 0, headsign: 'East terminus' },
			{ dir: 1, headsign: 'West terminus' },
			{ dir: 1, headsign: ' West terminus ' },
		]),
	).toEqual({ 1: 'West terminus' });
});

it.each([
	['/hotspots', '', { kind: 'line', measure: 'on_time', class: 'all' }],
	['/hotspots', 'class=all&measure=late', { kind: 'line', measure: 'late', class: 'all' }],
	['/hotspots', 'class=3%3Afrequent', { kind: 'line', measure: 'on_time', class: '3:frequent' }],
	['/hotspots', 'kind=stops&class=all&measure=missing_trips', { kind: 'stop', measure: 'on_time' }],
	['/repeat-offenders', '', { kind: 'departure', measure: 'on_time' }],
] as const)('streams the engine query for %s?%s', async (path: RankingPath, query, cuts) => {
	const finish: Array<(response: Response) => void> = [];
	fetcher.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish.push(resolve);
			}),
	);
	const url = new URL(`https://transit1.yesid.dev${path}?${dates}&${query}`);
	const record = await loadRankingsRecord(path, {
		url,
		request: new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.24' } }),
		parent: async () => ({ providerId: 'agency' }),
	});
	expect(record.answer).toBeInstanceOf(Promise);
	expect(record.reference).toBeInstanceOf(Promise);
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
	expect(fetcher).toHaveBeenCalledTimes(2);
	const reference = new URL(fetcher.mock.calls[1]![0].url);
	expect(reference.pathname).toBe('/v2/agency/measure');
	expect(Object.fromEntries(reference.searchParams)).toEqual({
		from: '2026-10-15',
		to: '2026-11-21',
		measure: cuts.measure,
	});
	for (const respond of finish)
		respond(new Response(null, { status: 503, headers: { 'retry-after': '1' } }));
	expect(await record.answer).toEqual({ kind: 'busy', retryAfterMs: 1_000 });
	expect(await record.reference).toEqual({ kind: 'busy', retryAfterMs: 1_000 });
});

it.each([true, false])('streams vehicle rankings with combined reference %s', async (combined) => {
	const path = '/repeat-offenders';
	const measure = 'vehicle_reporting_gaps_per_100_hours';
	const url = new URL(`https://transit1.yesid.dev${path}?kind=vehicle&${dates}`);
	const evidence = {
		start_date: '2026-10-15',
		end_date: '2026-11-21',
		days_included: [],
		days_measured: [],
		days_not_measured: [],
		method_version: '1',
		cleaning_versions: [],
		query_ms: 10,
	};
	const reference = {
		coverage_note: null,
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		value: { [measure]: 0.5 },
		evidence: { ...evidence, counts: { hours_in_service: 200, reporting_gaps: 1 } },
	};
	let finish!: (response: Response) => void;
	fetcher
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		)
		.mockResolvedValueOnce(Response.json(reference));
	const record = await loadRankingsRecord(path, {
		url,
		request: new Request(url),
		parent: async () => ({ providerId: 'agency' }),
	});
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(new URL(fetcher.mock.calls[0]![0].url).searchParams.get('kind')).toBe('vehicle');
	finish(
		Response.json({
			kind: 'vehicle',
			measure,
			class: null,
			available_classes: [],
			ranked_count: 0,
			rows: [],
			excluded: [],
			range_notes: {},
			coverage_note: null,
			evidence,
			info: [
				{ minimum_sample: 1, text: { en: { definition: 'Rate' }, fr: { definition: 'Taux' } } },
			],
			...(combined && { reference }),
		}),
	);
	expect(await record.answer).toMatchObject({ kind: 'answer', answer: { measure } });
	expect(await record.reference).toEqual({ kind: 'answer', answer: reference });
	expect(fetcher).toHaveBeenCalledTimes(combined ? 1 : 2);
	if (!combined) {
		const fallback = new URL(fetcher.mock.calls[1]![0].url);
		expect(fallback.pathname).toBe('/v2/agency/measure');
		expect(fallback.searchParams.get('measure')).toBe(measure);
	}
});

it('keeps vehicle tracking unavailable by provider capability', async () => {
	const url = new URL(`https://transit1.yesid.dev/rankings?kind=vehicle&${dates}`);
	const record = await loadRankingsRecord('/rankings', {
		url,
		request: new Request(url),
		parent: async () => ({
			providerId: 'agency',
			provider: { timezone: 'America/Toronto', inputs: { stable_vehicle_ids: false } },
		}),
	});
	expect(record).toMatchObject({ notTracked: true, answer: null, reference: null });
	expect(fetcher).not.toHaveBeenCalled();
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
	const response = await rankingsCsv('/hotspots', url, new Request(url), 'en');
	expect(response.status).toBe(400);
	expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
	expect(await response.text()).toContain('Check the city, dates and reading.');
	expect(fetcher).toHaveBeenCalledTimes(1);
});

it('forwards the same cuts and locale to the engine CSV and streams its rows with their source', async () => {
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
		'attachment; filename="agency-rankings-line-median_delay-all-2026-10-15-to-2026-11-21-fr.csv"',
	);
	expect(csvText(new Uint8Array(await response.arrayBuffer()))).toBe(
		'Rang,Type,Source des données et licence,Adresse de la licence\r\n1,line,"Données ouvertes d’Agency, calculs de Transit",\r\n',
	);
});

it('reads an excess-wait ranking that leaves out lines with no frequent periods', async () => {
	const url = new URL(
		`https://transit1.yesid.dev/rankings?kind=line&measure=excess_wait_time&${dates}`,
	);
	const evidence = {
		start_date: '2026-10-15',
		end_date: '2026-11-21',
		days_included: ['2026-11-21'],
		days_measured: ['2026-11-21'],
		days_not_measured: [],
		method_version: '1',
		cleaning_versions: [12],
		query_ms: 10,
	};
	const reason_text = {
		en: 'No frequent periods in this selection',
		fr: 'Aucune période de service fréquent dans ce choix',
	};
	fetcher.mockResolvedValue(
		Response.json({
			kind: 'line',
			measure: 'excess_wait_time',
			class: 'all',
			available_classes: [],
			ranked_count: 0,
			rows: [],
			excluded: [
				{
					id: '140',
					classes: [],
					sample: null,
					counts: {},
					reason: 'no_frequent_periods',
					reason_text,
				},
			],
			range_notes: {},
			coverage_note: null,
			evidence,
			info: [
				{ minimum_sample: 1, text: { en: { definition: 'Wait' }, fr: { definition: 'Attente' } } },
			],
		}),
	);
	const record = await loadRankingsRecord('/rankings', {
		url,
		request: new Request(url),
		parent: async () => ({ providerId: 'agency' }),
	});
	expect(await record.answer).toMatchObject({
		kind: 'answer',
		answer: {
			measure: 'excess_wait_time',
			excluded: [{ reason: 'no_frequent_periods', reason_text }],
		},
	});
});
