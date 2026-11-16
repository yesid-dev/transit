import { describe, expect, it } from 'vitest';
import type { RouteReliability } from '#lib/v1/index.ts';
import type { ReliabilitySnapshot } from '#lib/v1/reliabilitySnapshot.svelte.ts';
import { createDirectoryComparison } from './directoryEvidence';
import {
	comparisonEvidence,
	comparisonRows,
	DIRECTORY_PAGE_SIZE,
	directoryLineHref,
	directoryProviderHref,
	directoryScheduleHref,
	directorySearchParams,
	hasDirectoryFigure,
	nextPageSize,
	ordinaryEvidence,
	parseDirectoryState,
	problemAssessment,
	type DirectoryState,
} from './directoryState';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const WEEK = { window_start: '2026-11-04', window_end: '2026-11-10' };
const STAMP = { generated_utc: '2026-11-11T00:00:00Z', weekly_routes: [] as unknown[] };

function ranked(id: string, numerator: number, denominator: number, pct: number, rank: number) {
	return { id, numerator, denominator, pct, rank, state: 'ranked' as const, ...WEEK };
}

function comparison(rows: readonly unknown[]) {
	const result = createDirectoryComparison({ ...STAMP, weekly_routes: rows })(NOW);
	if (!result) throw new Error('fixture comparison was refused');
	return result;
}

function route(id: string, onTime: number, readings: number): RouteReliability {
	return {
		generated_utc: '2026-11-11T00:00:00Z',
		id,
		methodology_version: 'reliability-2',
		periods_by_grain: [
			{ grain: 'day', date: '2026-11-10' },
			{
				grain: 'week',
				date: '2026-11-04',
				by_daytype: [{ grain: 'weekday', observation_count: readings, on_time: onTime }],
			},
		],
		periods: [{ grain: 'day', date: '2026-11-10', observation_count: readings, on_time: onTime }],
	} as RouteReliability;
}

const ready = (file: RouteReliability): ReliabilitySnapshot => ({
	phase: 'ready',
	otpPct: 0,
	verdict: 'reliable',
	series: [],
	kind: 'route',
	routeData: file,
});

const line = (id: string, short = id) => ({ id, short, long: `Route ${id}`, type: 3 });

describe('directory URL state', () => {
	it('defaults to a clean first page in line-number order', () => {
		expect(parseDirectoryState(new URLSearchParams())).toEqual({
			query: '',
			mode: 'all',
			order: 'number',
			status: 'all',
			line: null,
			shown: DIRECTORY_PAGE_SIZE,
		});
	});

	it('reads the full view back from the URL', () => {
		const state = parseDirectoryState(
			new URLSearchParams('q=van+horne&mode=bus&status=problem&line=161&shown=60'),
		);
		expect(state).toEqual({
			query: 'van horne',
			mode: 'bus',
			order: 'number',
			status: 'problem',
			line: '161',
			shown: 60,
		});
	});

	it('never mixes comparison order with the latest-record problem filter', () => {
		expect(parseDirectoryState(new URLSearchParams('sort=worst&status=problem')).status).toBe(
			'problem',
		);
		expect(parseDirectoryState(new URLSearchParams('sort=worst&status=problem')).order).toBe(
			'number',
		);
		expect(parseDirectoryState(new URLSearchParams('sort=worst')).order).toBe('comparison');
	});

	it('drops a value the controls could not have produced', () => {
		const state = parseDirectoryState(
			new URLSearchParams('shown=25&line=%3Cscript%3E&mode=Bus&q=%20%20'),
		);
		expect(state.shown).toBe(DIRECTORY_PAGE_SIZE);
		// The opaque ID is only a hint until the view checks published route membership.
		expect(state.line).toBe('<script>');
		expect(state.mode).toBe('all');
		expect(state.query).toBe('');
	});

	it('mirrors only the state that differs from the defaults', () => {
		expect(directorySearchParams(parseDirectoryState(new URLSearchParams()))).toEqual({
			q: null,
			mode: null,
			sort: null,
			status: null,
			line: null,
			shown: null,
		});
		const state: DirectoryState = {
			query: '24',
			mode: 'bus',
			order: 'comparison',
			status: 'all',
			line: '24',
			shown: 40,
		};
		expect(directorySearchParams(state)).toEqual({
			q: '24',
			mode: 'bus',
			sort: 'worst',
			status: null,
			line: '24',
			shown: '40',
		});
	});

	it('adds twenty rows at a time and states the last real increment', () => {
		expect(nextPageSize(20, 235)).toBe(20);
		expect(nextPageSize(220, 235)).toBe(15);
		expect(nextPageSize(235, 235)).toBe(0);
	});
});

describe('directory comparison rows', () => {
	it('keeps the published order, then the remaining current lines below', () => {
		const rows = comparisonRows(
			[line('10'), line('2'), line('24'), line('99')],
			comparison([ranked('99', 20, 100, 20, 1), ranked('2', 40, 100, 40, 2)]),
		);
		expect(rows.map((row) => [row.line.id, row.ranked])).toEqual([
			['99', true],
			['2', true],
			['10', false],
			['24', false],
		]);
	});

	it('keeps an excluded line with its published reason and window', () => {
		const excluded = { id: '24', state: 'too_few_units' as const, ...WEEK };
		const rows = comparisonRows(
			[line('24'), line('2')],
			comparison([ranked('2', 40, 100, 40, 1), excluded]),
		);
		expect(rows[1]).toMatchObject({ ranked: false, entry: excluded });
	});

	it('gives a compared row its own window, counts and publication identity', () => {
		const compared = comparison([ranked('2', 40, 100, 40, 1)]);
		const evidence = comparisonEvidence(compared.ranked[0], compared);
		expect(evidence).toMatchObject({
			state: 'figure',
			percent: 40,
			readings: 100,
			from: '2026-11-04',
			to: '2026-11-10',
			days: 7,
			older: false,
			publication: compared.publication,
		});
	});

	it('marks an excluded row as older when its window is not the compared week', () => {
		const excluded = {
			id: '24',
			state: 'not_measured' as const,
			window_start: '2026-10-28',
			window_end: '2026-11-03',
		};
		const compared = comparison([ranked('2', 40, 100, 40, 1), excluded]);
		const evidence = comparisonEvidence(compared.entries[1], compared);
		expect(evidence).toMatchObject({
			state: 'unranked',
			percent: null,
			excluded: 'not_measured',
			older: true,
		});
	});
});

describe('ordinary row evidence', () => {
	const options = { noLive: false, lineId: '24' };

	it('names the measure, the readings and the record’s own complete week', () => {
		const evidence = ordinaryEvidence(ready(route('24', 750, 1000)), options);
		expect(evidence).toMatchObject({
			state: 'figure',
			percent: 75,
			readings: 1000,
			from: '2026-11-04',
			to: '2026-11-10',
			days: 7,
		});
		expect(evidence.publication.generatedUtc).toBe('2026-11-11T00:00:00Z');
		expect(evidence.publication.methodVersion).toBe('reliability-2');
	});

	it('keeps a measured zero as a figure', () => {
		expect(ordinaryEvidence(ready(route('24', 0, 1000)), options).percent).toBe(0);
	});

	it('withholds the figure below the published floor instead of showing a bare 0%', () => {
		const evidence = ordinaryEvidence(ready(route('24', 0, 12)), options);
		expect(evidence.state).toBe('low-sample');
		expect(evidence.percent).toBeNull();
		expect(evidence.readings).toBe(12);
	});

	it('names each state without inventing evidence', () => {
		expect(ordinaryEvidence(null, options).state).toBe('loading');
		expect(
			ordinaryEvidence({ ...ready(route('24', 750, 1000)), failed: true }, options).state,
		).toBe('failed');
		expect(
			ordinaryEvidence({ ...ready(route('24', 750, 1000)), routeData: null }, options).state,
		).toBe('not-published');
		expect(
			ordinaryEvidence(ready(route('24', 750, 1000)), { ...options, noLive: true }).state,
		).toBe('no-live');
	});

	it('never answers a row from another line’s file', () => {
		expect(
			ordinaryEvidence(ready(route('99', 750, 1000)), { ...options, lineId: '24' }).state,
		).toBe('not-published');
	});
});

describe('directory links carry the evidence, not the directory', () => {
	const base = new URL('http://localhost/fr/lines?provider=stm&q=24&shown=40&line=24&keep=1');

	it('drops the directory’s own view state and keeps the evidence’s complete days', () => {
		expect(
			directoryLineHref({
				base,
				path: '/fr/lines/24',
				providerId: 'stm',
				from: '2026-11-04',
				to: '2026-11-10',
				days: 7,
			}),
		).toBe('/fr/lines/24?provider=stm&keep=1&from=2026-11-04&to=2026-11-10');
	});

	it('writes no record period into the Schedule view', () => {
		expect(directoryScheduleHref({ base, path: '/fr/lines/24', providerId: 'stm' })).toBe(
			'/fr/lines/24?provider=stm&keep=1&tab=schedule',
		);
	});

	it('never turns a provider-bearing path into an encoded query', () => {
		expect(
			directoryLineHref({
				base,
				path: '/fr/lines/24?provider=stm',
				providerId: 'stm',
				from: '2026-11-04',
				to: '2026-11-10',
				days: 7,
			}),
		).toBe('/fr/lines/24?provider=stm&keep=1&from=2026-11-04&to=2026-11-10');
	});

	it('keeps only the provider on a map link', () => {
		expect(
			directoryProviderHref({
				base,
				path: '/fr/map?route=24&focus=route%3A24',
				providerId: 'stm',
			}),
		).toBe('/fr/map?route=24&focus=route%3A24&provider=stm');
	});
});

describe('problem assessment', () => {
	const options = { noLive: false, lineId: '24' };

	it.each([
		['reliable', 'clean'],
		['tentative', 'clean'],
		['absent', 'clean'],
		['patchy', 'problem'],
		['unreliable', 'problem'],
	] as const)('classifies a %s verdict as %s', (verdict, expected) => {
		const evidence = {
			...ordinaryEvidence(ready(route('24', 750, 1000)), options),
			verdictStatus: verdict,
		};
		expect(problemAssessment(evidence)).toBe(expected);
	});

	it('keeps a pending and a failed read out of the clean answer', () => {
		expect(problemAssessment(ordinaryEvidence(null, options))).toBe('pending');
		expect(
			problemAssessment({
				...ordinaryEvidence(ready(route('24', 750, 1000)), options),
				state: 'failed',
			}),
		).toBe('failed');
	});
});

describe('directory evidence provenance and supported figures', () => {
	it('preserves an opaque published ID through URL parsing and standard URI encoding', () => {
		const id = 'Ligné/中央 :01';
		const state = parseDirectoryState(new URLSearchParams({ line: id, shown: '240' }));
		expect(state.line).toBe(id);
		expect(state.shown).toBe(240);
		const href = directoryLineHref({
			base: new URL('https://transit.yesid.dev/fr/lines'),
			path: `/fr/lines/${encodeURIComponent(id)}`,
			providerId: 'stm',
		});
		expect(
			decodeURIComponent(new URL(href, 'https://transit.yesid.dev').pathname.split('/').at(-1)!),
		).toBe(id);
	});

	it.each([0, 12, 29])(
		'keeps %i known readings as low evidence, not an unpublished record',
		(readings) => {
			const evidence = ordinaryEvidence(ready(route('24', 0, readings)), {
				noLive: false,
				lineId: '24',
			});
			expect(evidence.state).toBe('low-sample');
			expect(evidence.readings).toBe(readings);
			expect(evidence.percent).toBeNull();
			expect(evidence.source).toBe('current_route_record');
		},
	);

	it('keeps an unranked comparison entry attributed to the index', () => {
		const entry = { id: '24', state: 'too_few_units' as const, ...WEEK };
		const cohort = comparison([ranked('77', 10, 100, 10, 1), entry]);
		const evidence = comparisonEvidence(entry, cohort);
		expect(evidence.source).toBe('published_weekly_index');
		expect(evidence.state).toBe('unranked');
		expect(evidence.percent).toBeNull();
		expect(evidence.readings).toBeNull();
	});

	it('does not call a later excluded period older', () => {
		const entry = {
			id: '24',
			state: 'not_measured' as const,
			window_start: '2026-11-11',
			window_end: '2026-11-17',
		};
		const cohort = comparison([ranked('77', 10, 100, 10, 1)]);
		expect(comparisonEvidence(entry, cohort).older).toBe(false);
	});

	it('admits a measured zero with a positive basis and retains unknown source metadata', () => {
		const evidence = ordinaryEvidence(ready(route('24', 0, 1000)), { noLive: false, lineId: '24' });
		expect(hasDirectoryFigure(evidence)).toBe(true);
		expect(evidence.percent).toBe(0);
		expect(evidence.publication.generationId).toBeNull();
	});

	it.each([
		{ readings: 0 },
		{ readings: -1 },
		{ readings: 29 },
		{ readings: 30.5 },
		{ readings: Number.MAX_SAFE_INTEGER + 1 },
		{ percent: Number.NaN },
		{ percent: Number.POSITIVE_INFINITY },
		{ percent: -1 },
		{ percent: 101 },
		{ percent: 50.5 },
		{ state: 'unranked' as const },
		{ from: null },
		{ from: '2026-02-30' },
		{ to: '2026-11-03' },
		{ days: 6 },
	])('withholds an unsupported figure or period: %j', (invalid) => {
		const valid = ordinaryEvidence(ready(route('24', 0, 1000)), { noLive: false, lineId: '24' });
		expect(hasDirectoryFigure({ ...valid, ...invalid })).toBe(false);
	});
});
