import { historyWeek } from './__fixtures__/closedWeek';
vi.mock('$app/navigation', () => ({ afterNavigate: () => {} }));
import { historyViewContract } from '#lib/features/reliability/__fixtures__/historyViewContract.ts';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteReliability } from '#lib/v1/index.ts';
import {
	HistoricCollectionIndexSchema,
	LineHistoryPartitionSchema,
	type HistoricCollectionIndex,
	type IsoUtc,
	type LineHistoryPartition,
} from '#lib/v1/schemas/index.ts';
import { historyRangeRequestFromSearchParams } from '#lib/v1/history/rangeResource.svelte.ts';
import {
	createLineHistoryResource,
	loadLineHistorySeed,
	type LineHistoryResource,
} from './data/lineHistoryResource.svelte';
import RouteReliabilityClusters from './RouteReliabilityClusters.svelte';
import { reliabilityCopy } from './reliability.copy';
import { describeAbsence } from '#lib/site/absence.ts';
import { downloadedTable } from './__fixtures__/csvTable';

const harness = vi.hoisted(() => {
	const page = { url: new URL('http://localhost/lines/A%2FB?tab=reliability'), state: {} };
	const mirrorSearchParams = vi.fn((values: Record<string, string | null>) => {
		const next = new URL(page.url);
		for (const [key, value] of Object.entries(values)) {
			if (value == null) next.searchParams.delete(key);
			else next.searchParams.set(key, value);
		}
		page.url = next;
	});
	return {
		page,
		mirrorSearchParams,
		getLineHistoryIndex: vi.fn(),
		loadLineHistoryRange: vi.fn(),
	};
});

vi.mock('$app/state', () => ({ page: harness.page }));
vi.mock('#lib/site/urlMirror.ts', () => ({
	mirrorSearchParams: harness.mirrorSearchParams,
	mirrorSearchParam: vi.fn(),
}));
vi.mock('#lib/nav/index.ts', () => ({ layout: { isDesktop: true } }));
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getLineHistoryIndex: harness.getLineHistoryIndex,
	loadLineHistoryRange: harness.loadLineHistoryRange,
}));

const entityId = 'A/B';
const generatedUtc = '2026-07-13T12:00:00Z' as IsoUtc;
const window = { from: '2026-01-31', to: '2026-02-01' } as const;
const generation = 'c'.repeat(64);

function partitionRef(month: string, date: string, shaCharacter: string) {
	const sha = shaCharacter.repeat(64);
	return {
		path: `historic/history/lines/412f42/generations/${sha}/${month}.json`,
		coverage_start: date,
		coverage_end: date,
		count: 1,
		sha256: sha,
		byte_size: 100,
	};
}

function metric(metric: string, aggregation: string) {
	return {
		metric,
		aggregation,
		first_available_date: window.from,
		last_available_date: window.to,
		gaps: [],
	};
}

const historyIndex = HistoricCollectionIndexSchema.parse({
	generated_utc: generatedUtc,
	family: 'lines',
	selection_mode: 'range',
	entity_id: entityId,
	collection_generation_id: generation,
	first_available_date: window.from,
	last_available_date: window.to,
	gaps: [],
	partitions: [
		partitionRef('2026-01', '2026-01-31', 'a'),
		partitionRef('2026-02', '2026-02-01', 'b'),
	],
	metrics: [
		metric('delay', 'additive'),
		metric('delay_percentiles', 'daily_only'),
		metric('cancellation', 'additive'),
		metric('occupancy', 'additive'),
		metric('service_span', 'daily_only'),
		metric('skipped_stops', 'additive'),
	],
}) as HistoricCollectionIndex;

function retainedDay(
	date: string,
	observations: number,
	inClamp: number,
	onTime: number,
	sumDelaySeconds: number,
) {
	return {
		date,
		delay: {
			observation_count: observations,
			in_clamp_observation_count: inClamp,
			on_time_count: onTime,
			severe_count: 1,
			sum_delay_seconds: sumDelaySeconds,
		},
		delay_percentiles: {
			observation_count: observations,
			p50_delay_seconds: 60,
			p90_delay_seconds: 180,
		},
		cancellation: {
			canceled_trip_days: 1,
			total_trip_days: 10,
			scheduled_trip_days: 12,
			delivered_trip_days: 9,
			silent_trip_days: 2,
		},
		occupancy: { empty: 1, many_seats: 2, few_seats: 3, standing: 4, full: 0 },
		service_span: {
			trip_count: 9,
			first_trip_utc: `${date}T10:00:00Z`,
			last_trip_utc: `${date}T20:00:00Z`,
			first_trip_delay_seconds: 30,
			last_trip_delay_seconds: -30,
		},
		skipped_stops: { skipped_stop_count: 2, stop_time_update_count: 100 },
	};
}

const retainedPartitions = [
	LineHistoryPartitionSchema.parse({
		generated_utc: generatedUtc,
		month: '2026-01',
		entity_id: entityId,
		days: [retainedDay('2026-01-31', 10, 5, 2, 600)],
	}),
	LineHistoryPartitionSchema.parse({
		generated_utc: generatedUtc,
		month: '2026-02',
		entity_id: entityId,
		days: [retainedDay('2026-02-01', 90, 90, 81, 5_400)],
	}),
] as LineHistoryPartition[];

const noDelayPartitions = [
	LineHistoryPartitionSchema.parse({
		generated_utc: generatedUtc,
		month: '2026-01',
		entity_id: entityId,
		days: [
			{
				date: '2026-01-31',
				cancellation: {
					canceled_trip_days: 1,
					total_trip_days: 10,
					scheduled_trip_days: 10,
					delivered_trip_days: 9,
					silent_trip_days: 0,
				},
			},
		],
	}),
	LineHistoryPartitionSchema.parse({
		generated_utc: generatedUtc,
		month: '2026-02',
		entity_id: entityId,
		days: [
			{
				date: '2026-02-01',
				cancellation: {
					canceled_trip_days: 0,
					total_trip_days: 10,
					scheduled_trip_days: 10,
					delivered_trip_days: 10,
					silent_trip_days: 0,
				},
			},
		],
	}),
] as LineHistoryPartition[];

const current: RouteReliability = {
	periods_by_grain: historyWeek.periods_by_grain,
	id: entityId,
	generated_utc: generatedUtc,
	periods: [
		{
			grain: 'day',
			date: '2026-07-12',
			otp_pct: 12,
			avg_delay_min: 9,
			observation_count: 100,
			on_time: 12,
		},
		{ grain: 'week', date: '2026-07-06', otp_pct: 22 },
		{ grain: 'month', date: '2026-07', otp_pct: 33 },
		{ grain: 'am_peak', date: null, otp_pct: 44, avg_delay_min: 4 },
	],
	headway: [{ shift: 'am_peak', scheduled_min: 6, observed_min: 9 }],
	habits: { scale: 'repeat_problem_relative', matrix: [[0.5]] },
	weak_stops: [{ id: 'stop-1', name: 'Current stop', avg_delay_min: 8 }],
	cancellations: [
		{
			grain: 'day',
			date: '2026-07-12',
			cancellation_rate_pct: 99,
			canceled_trip_days: 9,
			total_trip_days: 10,
		},
	],
	occupancy_mix: { empty: 0, many_seats: 0, few_seats: 0, standing: 0, full: 1 },
	occupancy_by_grain: [
		{ grain: 'day', mix: { empty: 0, many_seats: 0, few_seats: 0, standing: 0, full: 1 } },
	],
	service_spans: [{ date: '2026-07-12', trip_count: 1 }],
	skipped_stops: [
		{
			date: '2026-07-12',
			skipped_stop_rate_pct: 99,
			skipped_stop_count: 9,
			stop_time_update_count: 10,
		},
	],
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

function createHistory() {
	return createLineHistoryResource(
		entityId,
		historyRangeRequestFromSearchParams(harness.page.url.searchParams),
	);
}

function staticHistory(state: LineHistoryResource['state']): LineHistoryResource {
	return {
		request: { hasFrom: true, hasTo: true, rawFrom: window.from, rawTo: window.to },
		index: historyIndex,
		resolved: null,
		value: null,
		state,
		error: null,
		setRequest: vi.fn(),
		retry: vi.fn(),
		destroy: vi.fn(),
	};
}

function activeWindowText(container: HTMLElement): string {
	return container.querySelector('[data-slot="active-window"]')?.textContent?.trim() ?? '';
}

function expectMultiDayCaption(container: HTMLElement): void {
	const caption = activeWindowText(container);
	expect.soft(caption).toContain(window.from);
	expect.soft(caption).toContain(window.to);
	expect.soft(caption).not.toBe(reliabilityCopy.en.controls.activeWindow.singleDay(window.from));
}

function expectAnnounced(container: HTMLElement, message: string): void {
	const liveStatuses = [...container.querySelectorAll<HTMLElement>('[role="status"]')];
	expect.soft(liveStatuses.some((status) => status.textContent?.includes(message))).toBe(true);
}

beforeEach(() => {
	harness.page.url = new URL('http://localhost/lines/A%2FB?tab=reliability');
	harness.mirrorSearchParams.mockClear();
	harness.getLineHistoryIndex.mockReset().mockResolvedValue(historyIndex);
	harness.loadLineHistoryRange.mockReset().mockResolvedValue(retainedPartitions);
});

afterEach(() => cleanup());

describe('RouteReliabilityClusters retained Line history', () => {
	it('exports a partial range’s daily gap and unavailable trip facts without current mix or fabricated completeness', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?provider=octranspo&from=2026-01-31&to=2026-02-01',
		);
		const first = retainedPartitions[0].days[0];
		harness.loadLineHistoryRange.mockResolvedValue([
			{ ...retainedPartitions[0], days: [{ date: first.date, delay: first.delay }] },
			{ ...retainedPartitions[1], days: [{ date: '2026-02-01' }] },
		]);
		const history = createHistory();
		try {
			const view = render(RouteReliabilityClusters, {
				data: current,
				locale: 'en',
				history,
				citation: { line: 'A/B', providerId: 'octranspo', providerName: 'OC Transpo' },
			});
			const link = (block: string) =>
				view.container.querySelector<HTMLAnchorElement>(`a[download*="-${block}-"]`);
			await waitFor(() => expect(link('day-by-day')).not.toBeNull());
			const days = downloadedTable(link('day-by-day')!);
			expect(days.map((r) => [r.date, r.on_time_pct, r.readings, r.state])).toEqual([
				['2026-01-31', '20', '10', 'published'],
				['2026-02-01', '', '', 'gap'],
			]);
			const facts = downloadedTable(link('trip-facts')!);
			expect(facts.map((r) => [r.measure, r.state, r.numerator, r.denominator])).toEqual([
				['cancelled', 'not_published', '', ''],
				['missing_trips', 'not_published', '', ''],
				['silent_trips', 'live_only', '', ''],
				['skipped', 'not_published', '', ''],
			]);
			expect(link('crowding-mix')).toBeNull();
		} finally {
			history.destroy();
		}
	});
	it('keeps retained answers and the current undated diagnostics on separate identities through load and refresh', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?provider=stm&from=2026-01-31&to=2026-02-01',
		);
		const gate = deferred<LineHistoryPartition[]>();
		harness.loadLineHistoryRange.mockReturnValueOnce(gate.promise);
		const history = createHistory();
		const citation = {
			line: 'A/B',
			providerId: 'stm',
			providerName: 'STM',
			attribution: 'Contains STM data made available under CC BY 4.0.',
		};
		const data = {
			...current,
			generated_utc: '2026-11-11T06:00:00Z' as IsoUtc,
			publish_generation_id: 'current-g1',
			methodology_version: 'current-method',
			delay_by_crowding: [
				{ band: 'full' as const, avg_delay_min: -2.5, p50_min: -3, observation_count: 40 },
			],
		};
		const view = render(RouteReliabilityClusters, { data, locale: 'en', citation, history });
		const link = (block: string) =>
			view.container.querySelector<HTMLAnchorElement>(`a[download*="-${block}-"]`);
		try {
			await waitFor(() => expect(history.state).toBe('loading-range'));
			expect(link('record')).toBeNull();
			expect(link('trip-facts')).toBeNull();
			gate.resolve(
				retainedPartitions.map((p, index) => ({
					...p,
					generated_utc: index === 0 ? generatedUtc : ('2026-08-13T12:00:00Z' as IsoUtc),
					publish_generation_id: 'retained-g',
					methodology_version: index === 0 ? 'retained-old' : 'retained-new',
				})),
			);
			await waitFor(() => expect(link('record')).not.toBeNull());
			for (const band of ['verdict', 'the-wait', 'when-to-ride', 'crowding']) {
				const section = view.container.querySelector<HTMLElement>(`[data-band="${band}"]`)!;
				await fireEvent.click(
					within(section).getByRole('button', { name: reliabilityCopy.en.sections.detailShow }),
				);
			}
			expect(downloadedTable(link('record')!)[0]).toMatchObject({
				source: 'retained_partitions',
				on_time_pct: '83',
				readings: '100',
				window_from: window.from,
				window_to: window.to,
				publication_generated_utc: '',
				publication_generation_id: 'retained-g',
				publication_methodology_version: '',
				attribution: citation.attribution,
			});
			expect(
				downloadedTable(link('delay-summary')!).find((r) => r.measure === 'average_delay'),
			).toMatchObject({
				delay_min: '1.1',
				readings: '95',
				readings_basis: 'in_clamp_delay_predictions',
				record_readings: '100',
			});
			const retainedUrl = new URL(downloadedTable(link('record')!)[0].record_url);
			expect(retainedUrl.searchParams.get('generation')).toBe('retained-g');
			expect(downloadedTable(link('severe-readings')!)[0]).toMatchObject({
				late_share_pct: '2',
				readings: '100',
			});
			expect(downloadedTable(link('service-span')!)[0]).toMatchObject({
				source: 'retained_partitions',
				date: '2026-02-01',
				window_from: '2026-02-01',
				window_to: '2026-02-01',
				trip_count: '9',
				last_delay_min: '-0.5',
			});
			const relative = downloadedTable(link('relative-pattern')!);
			expect(relative[0]).toMatchObject({
				source: 'current_line_file',
				scope: 'history',
				window_from: '',
				window_to: '',
				value: '0.5',
				unit: 'row_relative_score',
				publication_generated_utc: data.generated_utc,
				publication_generation_id: 'current-g1',
				publication_methodology_version: 'current-method',
			});
			expect(new URL(relative[0].record_url).searchParams.get('generation')).toBe('current-g1');
			expect(downloadedTable(link('crowding-mix')!)[0]).toMatchObject({
				source: 'retained_partitions',
				scope: 'window',
				window_from: window.from,
				window_to: window.to,
				readings: '',
				publication_generation_id: 'retained-g',
			});
			const diagnostic = () =>
				downloadedTable(link('crowding-delay')!).find((r) => r.key === 'full')!;
			expect(diagnostic()).toMatchObject({
				source: 'current_line_file',
				scope: 'undated_diagnostics',
				window_from: '',
				window_to: '',
				value: '-2.5',
				p50_delay_min: '-3',
				readings: '40',
				publication_generation_id: 'current-g1',
			});
			expect(new URL(diagnostic().record_url).searchParams.get('generation')).toBe('current-g1');
			expect(link('time-of-day')).toBeNull();
			expect(link('gaps')).toBeNull();
			expect(link('stop-delays')).toBeNull();
			const fetches = harness.loadLineHistoryRange.mock.calls.length;
			await fireEvent.click(link('record')!);
			expect(harness.loadLineHistoryRange).toHaveBeenCalledTimes(fetches);
			await view.rerender({
				data: {
					...data,
					publish_generation_id: 'current-g2',
					delay_by_crowding: [{ band: 'full', avg_delay_min: 7.5, observation_count: 80 }],
				},
				locale: 'en',
				citation,
				history,
			});
			await waitFor(() =>
				expect(diagnostic()).toMatchObject({
					value: '7.5',
					readings: '80',
					publication_generation_id: 'current-g2',
				}),
			);
			expect(new URL(diagnostic().record_url).searchParams.get('generation')).toBe('current-g2');
			expect(downloadedTable(link('record')!)[0].publication_generation_id).toBe('retained-g');
			expect(
				new URL(downloadedTable(link('record')!)[0].record_url).searchParams.get('generation'),
			).toBe('retained-g');
		} finally {
			history.destroy();
		}
	});

	it.each(['loading-range', 'error', 'no-data'] as const)(
		'offers no selected-record downloads for %s retained ranges',
		(state) => {
			harness.page.url = new URL(
				'http://localhost/lines/A%2FB?provider=stm&from=2026-01-31&to=2026-02-01',
			);
			const view = render(RouteReliabilityClusters, {
				data: current,
				locale: 'en',
				history: staticHistory(state),
				citation: { line: 'A/B', providerId: 'stm', providerName: 'STM' },
			});
			for (const block of [
				'record',
				'day-by-day',
				'delay-summary',
				'service-span',
				'trip-facts',
				'crowding-mix',
			])
				expect(view.container.querySelector(`a[download*="-${block}-"]`)).toBeNull();
		},
	);
	it('renders accepted server counts and source date immediately without reloading the selected partition', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-01-31',
		);
		harness.loadLineHistoryRange.mockResolvedValue([retainedPartitions[0]]);
		const request = historyRangeRequestFromSearchParams(harness.page.url.searchParams);
		const seed = await loadLineHistorySeed(entityId, request, {
			signal: new AbortController().signal,
		});
		expect(seed.index?.generated_utc).toBe(generatedUtc);
		expect(seed.result?.value?.aggregate.delay.value).toMatchObject({
			observationCount: 10,
			onTimeCount: 2,
			severeCount: 1,
			averageDelaySeconds: 120,
			otpPct: 20,
			severePct: 10,
		});
		harness.getLineHistoryIndex.mockClear();
		harness.loadLineHistoryRange.mockClear();
		const history = createLineHistoryResource(entityId, request, () => seed);
		try {
			expect(history.state).toBe('ready');
			const view = render(RouteReliabilityClusters, {
				props: { data: current, locale: 'en', history },
			});
			const verdict = view.container.querySelector('[data-band="verdict"]') as HTMLElement;
			expect(verdict).toHaveTextContent('20%');
			expect(verdict).not.toHaveTextContent('12%');
			expect(activeWindowText(view.container)).toContain('2026-01-31');
			await fireEvent.click(
				within(verdict).getByRole('button', { name: reliabilityCopy.en.sections.detailShow }),
			);
			expect(verdict.querySelector('[data-slot="daily-percentile-spread"]')).toHaveTextContent(
				'p90 − median spread: 2.0 min. 2026-01-31 · 10 eligible delay predictions.',
			);
			expect(harness.getLineHistoryIndex).not.toHaveBeenCalled();
			expect(harness.loadLineHistoryRange).not.toHaveBeenCalled();
		} finally {
			history.destroy();
		}
	});

	it.each(['en', 'fr'] as const)(
		'keeps retained one-day percentiles exact and multi-day percentiles absent in %s',
		async (locale) => {
			harness.page.url = new URL(
				'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-01-31',
			);
			harness.loadLineHistoryRange.mockResolvedValueOnce([retainedPartitions[0]]);
			const history = createHistory();
			const view = render(RouteReliabilityClusters, {
				props: {
					data: current,
					locale,
					history,
					citation: { line: 'A/B', providerId: 'stm', providerName: 'STM' },
				},
			});
			try {
				await waitFor(() => expect(history.state).toBe('ready'));
				const tiles = () =>
					['p50', 'p90'].map(
						(metric) =>
							view.container.querySelector(
								`[data-slot="record-delays"] [data-metric="${metric}"] dd`,
							) as HTMLElement,
					);
				expect(tiles().map((tile) => tile.textContent?.trim())).toEqual(
					locale === 'en' ? ['1.0 min', '3.0 min'] : ['1,0 min', '3,0 min'],
				);
				const csv = view.container.querySelector<HTMLAnchorElement>(
					'a[download*="-delay-summary-"]',
				)!;
				expect(downloadedTable(csv).find((row) => row.measure === 'p50_delay')).toMatchObject({
					delay_min: '1',
					readings: '10',
					readings_basis: 'published_delay_percentile_observations',
					record_readings: '10',
				});
				expect(harness.loadLineHistoryRange).toHaveBeenCalledTimes(1);
				history.setRequest(
					historyRangeRequestFromSearchParams(new URLSearchParams('from=2026-01-31&to=2026-02-01')),
				);
				await waitFor(() => expect(history.value?.aggregate.window.to).toBe('2026-02-01'));
				for (const tile of tiles())
					expect(tile.querySelector('[data-slot="absent-value"]')).not.toBeNull();
				expect(harness.loadLineHistoryRange).toHaveBeenCalledTimes(2);
			} finally {
				history.destroy();
			}
		},
	);

	it('adds a same-day percentile spread without loading another partition', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-01-31',
		);
		harness.loadLineHistoryRange.mockResolvedValue([retainedPartitions[0]]);
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});
		try {
			await waitFor(() => expect(history.state).toBe('ready'));
			const verdict = view.container.querySelector('[data-band="verdict"]') as HTMLElement;
			await fireEvent.click(
				within(verdict).getByRole('button', { name: reliabilityCopy.en.sections.detailShow }),
			);
			expect(verdict.querySelector('[data-slot="daily-percentile-spread"]')).toHaveTextContent(
				'p90 − median spread: 2.0 min. 2026-01-31 · 10 eligible delay predictions.',
			);
			const distribution = verdict.querySelector('[data-slot="delay-distribution"]') as HTMLElement;
			const delays = verdict.querySelector('[data-slot="record-delays"]') as HTMLElement;
			expect(delays.querySelector('[data-metric="p50"] dd')).toHaveTextContent('1.0 min');
			expect(delays.querySelector('[data-metric="p90"] dd')).toHaveTextContent('3.0 min');
			expect(distribution.querySelector('[data-slot="absent-value"]')).toHaveTextContent(
				'the selected view does not publish a delay histogram',
			);
			expect(distribution).not.toHaveTextContent('not enough readings yet');
			expect(distribution.querySelector('[data-slot="delay-dist-caption"]')).toBeNull();
			expect(harness.loadLineHistoryRange).toHaveBeenCalledTimes(1);
		} finally {
			history.destroy();
		}
	});

	it('cites a retained range by its own publication, never the current snapshot’s', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-01-31',
		);
		harness.loadLineHistoryRange.mockResolvedValue([
			LineHistoryPartitionSchema.parse({
				...retainedPartitions[0],
				generated_utc: '2026-02-03T05:00:00Z',
				publish_generation_id: 'stm@2026-02-03T05:00:00Z',
				methodology_version: 'reliability-2',
			}),
		]);
		const writeText = vi.fn(async (_text: string) => {});
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: {
				data: current,
				locale: 'en',
				history,
				citation: { line: 'A/B', providerId: 'stm', providerName: 'STM' },
			},
		});
		try {
			await waitFor(() => expect(history.state).toBe('ready'));
			await fireEvent.click(view.getByRole('button', { name: 'Cite this record' }));
			const text = writeText.mock.calls[0][0];
			expect(text).toContain(
				'Record published Feb 3, 2026, generation stm@2026-02-03T05:00:00Z, method reliability-2.',
			);
			expect(text).not.toContain('Jul 13, 2026');
		} finally {
			history.destroy();
			vi.unstubAllGlobals();
		}
	});

	it('keeps the default no-range service structure unchanged', async () => {
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});

		try {
			await waitFor(() => expect(history.index).not.toBeNull());
			expect(view.container.querySelector('[data-slot="cancellations"]')).not.toBeNull();
			expect(view.container.querySelector('[data-slot="skipped-stops"]')).not.toBeNull();
			expect(view.container.querySelector('[data-slot="service-completeness"]')).toBeNull();
		} finally {
			history.destroy();
		}
	});

	it('uses one navigator in the existing rail and keeps exactly four grain choices', async () => {
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});
		await waitFor(() => expect(history.index).not.toBeNull());

		expect(view.container.querySelectorAll('[data-slot="surface-rail"]')).toHaveLength(1);
		expect(
			view.getAllByRole('radio', {
				name: /Latest complete day|Last 7 days|Last 30 days|Date range/,
			}),
		).toHaveLength(4);
		await fireEvent.click(view.getByRole('radio', { name: reliabilityCopy.en.controls.dateRange }));
		const rail = view.container.querySelector('[data-slot="surface-rail"]') as HTMLElement;
		expect(within(rail).getAllByRole('region', { name: /history/i })).toHaveLength(1);
		expect(rail.querySelectorAll<HTMLInputElement>('input[type="date"]')).toHaveLength(2);
		history.destroy();
	});

	it('keeps a corrected-range message visibly mounted after returning to the current view', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2025-01-01&to=2025-01-02',
		);
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});

		try {
			await waitFor(() => expect(history.state).toBe('current'));
			expect(view.container.querySelector('[data-slot="history-correction"]')).toHaveTextContent(
				reliabilityCopy.en.history.correction['outside-coverage'],
			);
			expect(view.container.querySelector('[data-slot="history-navigator"]')).toBeNull();
		} finally {
			history.destroy();
		}
	});

	it('shows one corrected-range message when an explicit range stays mounted', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&grain=range&from=2025-01-01&to=2025-01-02',
		);
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});

		try {
			await waitFor(() => expect(history.state).toBe('current'));
			const correction = reliabilityCopy.en.history.correction['outside-coverage'];
			expect(
				Array.from(
					view.container.querySelectorAll(
						'[data-slot="history-announcement"], [data-slot="history-correction"]',
					),
				).filter((element) => element.textContent?.trim() === correction),
			).toHaveLength(1);
		} finally {
			history.destroy();
		}
	});

	it.each([
		['a lone bound', 'from=2026-01-31'],
		['a malformed bound', 'from=not-a-date&to=2026-02-01'],
	] as const)(
		'announces and clears %s without losing the coordinator correction',
		async (_, query) => {
			harness.page.url = new URL(
				`http://localhost/lines/A%2FB?tab=reliability&focus=keep&${query}`,
			);
			const history = createHistory();
			const view = render(RouteReliabilityClusters, {
				props: { data: current, locale: 'en', history },
			});

			try {
				await waitFor(() => expect(history.state).toBe('current'));
				const correction = reliabilityCopy.en.history.correction.malformed;
				expect(
					Array.from(view.container.querySelectorAll('[data-slot="history-correction"]')).filter(
						(element) => element.textContent?.trim() === correction,
					),
				).toHaveLength(1);
				expect(harness.loadLineHistoryRange).not.toHaveBeenCalled();
				expect(harness.page.url.searchParams.get('from')).toBeNull();
				expect(harness.page.url.searchParams.get('to')).toBeNull();
				expect(harness.page.url.searchParams.get('tab')).toBe('reliability');
				expect(harness.page.url.searchParams.get('focus')).toBe('keep');
			} finally {
				history.destroy();
			}
		},
	);

	it('keeps blank-bound range intent canonical when retained discovery fails', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&focus=keep&from=&to=2026-02-01',
		);
		harness.getLineHistoryIndex.mockRejectedValue(new Error('retained index unavailable'));
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});

		try {
			await waitFor(() => expect(history.state).toBe('error'));
			expect(activeWindowText(view.container)).toBe(
				reliabilityCopy.en.controls.activeWindow.rangePrompt,
			);
			expect(harness.page.url.searchParams.get('grain')).toBe('range');
			expect(harness.page.url.searchParams.get('from')).toBeNull();
			expect(harness.page.url.searchParams.get('to')).toBeNull();
			expect(harness.page.url.searchParams.get('tab')).toBe('reliability');
			expect(harness.page.url.searchParams.get('focus')).toBe('keep');
		} finally {
			history.destroy();
		}
	});

	it('keeps the current singleton range usable when the optional retained index is absent', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-07-12&to=2026-07-12&focus=keep',
		);
		harness.getLineHistoryIndex.mockResolvedValue(null);
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});

		try {
			await waitFor(() => expect(history.state).toBe('current'));
			const range = view.getByRole('radio', { name: reliabilityCopy.en.controls.dateRange });
			expect(range).toHaveAttribute('aria-checked', 'true');
			const rail = view.container.querySelector('[data-slot="surface-rail"]') as HTMLElement;
			expect(within(rail).getAllByRole('region', { name: /history/i })).toHaveLength(1);
			const bounds = rail.querySelectorAll<HTMLInputElement>('input[type="date"]');
			expect(bounds).toHaveLength(2);
			expect(bounds[0]).toHaveValue('2026-07-12');
			expect(bounds[1]).toHaveValue('2026-07-12');
			expect(activeWindowText(view.container)).toContain('2026-07-12');
			expect(harness.loadLineHistoryRange).not.toHaveBeenCalled();
			expect(harness.page.url.searchParams.get('from')).toBe('2026-07-12');
			expect(harness.page.url.searchParams.get('to')).toBe('2026-07-12');
			expect(harness.page.url.searchParams.get('focus')).toBe('keep');
		} finally {
			history.destroy();
		}
	});

	it('keeps both selected bounds visible and announces a partial range with no delay rows', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-02-01',
		);
		harness.loadLineHistoryRange.mockResolvedValue(noDelayPartitions);
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});

		try {
			await waitFor(() => expect(history.state).toBe('partial'));
			expectMultiDayCaption(view.container);
			expectAnnounced(view.container, reliabilityCopy.en.history.partial);
		} finally {
			history.destroy();
		}
	});

	it('announces an honest no-data retained range', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-02-01',
		);
		const history = staticHistory('no-data');
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});

		expectMultiDayCaption(view.container);
		const absence = describeAbsence('no-retained-data', 'en');
		expectAnnounced(view.container, absence.label);
		expectAnnounced(view.container, absence.why);
	});

	it('announces a retained-range error, preserves the multi-day caption, and offers retry', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-02-01',
		);
		harness.loadLineHistoryRange
			.mockRejectedValueOnce(new Error('retained range unavailable'))
			.mockResolvedValueOnce(retainedPartitions);
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});

		try {
			await waitFor(() => expect(history.state).toBe('error'));
			expectMultiDayCaption(view.container);
			expectAnnounced(view.container, reliabilityCopy.en.history.error);

			const retry = view.queryByRole('button', { name: /retry/i });
			expect.soft(retry).not.toBeNull();
			if (retry) {
				await fireEvent.click(retry);
				await waitFor(() => expect(harness.loadLineHistoryRange).toHaveBeenCalledTimes(2));
				await waitFor(() => expect(history.state).toBe('ready'));
			}
		} finally {
			history.destroy();
		}
	});

	it('keeps a deep-linked retained range while discovery is pending even when the current file has no dated rows', async () => {
		const pendingIndex = deferred<HistoricCollectionIndex | null>();
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-02-01',
		);
		harness.getLineHistoryIndex.mockReturnValue(pendingIndex.promise);
		const history = createHistory();
		render(RouteReliabilityClusters, {
			props: { data: { ...current, periods: [] }, locale: 'en', history },
		});

		try {
			await waitFor(() => expect(harness.getLineHistoryIndex).toHaveBeenCalledTimes(1));
			expect(history.request).toEqual({
				hasFrom: true,
				hasTo: true,
				rawFrom: window.from,
				rawTo: window.to,
			});

			pendingIndex.resolve(historyIndex);
			await waitFor(() => expect(harness.loadLineHistoryRange).toHaveBeenCalledTimes(1));
		} finally {
			history.destroy();
		}
	});

	it('labels current-only sections once and never propagates the selected range into stop links', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-02-01',
		);
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});
		await waitFor(() => expect(history.state).toBe('ready'));

		expect(view.container.querySelectorAll('[data-slot="history-current-only"]')).toHaveLength(1);
		for (const link of view.container.querySelectorAll<HTMLAnchorElement>('a[href^="/stop/"]')) {
			expect(link.getAttribute('href')).not.toMatch(/[?&](?:tab|grain|from|to)=/);
		}
		history.destroy();
	});

	it('marks a current-file link unverifiable when the settled retained range supplies no generation', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-02-01&generation=current-g&published=2026-11-11T06%3A00%3A00Z&method=current-method',
		);
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});
		try {
			await waitFor(() => expect(history.state).toBe('ready'));
			const notice = view.container.querySelector('[data-slot="record-edition"]');
			expect(notice).toHaveTextContent(reliabilityCopy.en.record.edition.unverifiable);
		} finally {
			history.destroy();
		}
	});

	it('states a corrected retained edition from its own newer publication, never the current file', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-02-01&generation=retained-old&published=2026-01-01T00%3A00%3A00Z&method=reliability-1',
		);
		harness.loadLineHistoryRange.mockResolvedValue([
			{
				...retainedPartitions[0],
				generated_utc: '2026-07-13T12:00:00Z',
				publish_generation_id: 'retained-g',
				methodology_version: 'reliability-2',
			},
			{
				...retainedPartitions[1],
				generated_utc: '2026-07-13T12:00:00Z',
				publish_generation_id: 'retained-g',
				methodology_version: 'reliability-2',
			},
		]);
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});
		try {
			await waitFor(() => expect(history.state).toBe('ready'));
			const notice = view.container.querySelector('[data-slot="record-edition"]');
			expect(notice).toHaveTextContent(reliabilityCopy.en.record.edition.corrected('Jul 13, 2026'));
			expect(notice).not.toHaveTextContent('Nov 11, 2026');
		} finally {
			history.destroy();
		}
	});

	it.each(['loading-range', 'error'] as const)(
		'makes no edition conclusion while the retained read is %s',
		(state) => {
			harness.page.url = new URL(
				'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-02-01&generation=old-g&published=2026-01-01T00%3A00%3A00Z&method=old',
			);
			const view = render(RouteReliabilityClusters, {
				props: { data: current, locale: 'en', history: staticHistory(state) },
			});
			expect(view.container.querySelector('[data-slot="record-edition"]')).toBeNull();
		},
	);

	it('says the requested edition is unavailable for a settled retained no-data period', () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&from=2026-01-31&to=2026-02-01&generation=old-g&published=2026-01-01T00%3A00%3A00Z&method=old',
		);
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history: staticHistory('no-data') },
		});
		expect(view.container.querySelector('[data-slot="record-edition"]')).toHaveTextContent(
			reliabilityCopy.en.record.edition.unavailable,
		);
	});

	it('strips the record period and edition hints from the Record→Live link', async () => {
		harness.page.url = new URL(
			'http://localhost/lines/A%2FB?tab=reliability&grain=week&provider=stm&focus=keep&generation=old&published=2026-01-01T00%3A00%3A00Z&method=old',
		);
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en' },
		});
		const section = view.container.querySelector<HTMLElement>('[data-band="run-and-fit"]')!;
		const href = within(section).getByRole('link', { name: 'See live now' }).getAttribute('href')!;
		const url = new URL(href, 'http://localhost');
		expect(url.searchParams.get('tab')).toBe('detail');
		expect(url.searchParams.get('provider')).toBe('stm');
		expect(url.searchParams.get('focus')).toBe('keep');
		for (const key of ['grain', 'from', 'to', 'generation', 'published', 'method'])
			expect(url.searchParams.get(key)).toBeNull();
	});

	it('defines honest retained-history and current-only copy in English and French', () => {
		for (const locale of ['en', 'fr'] as const) {
			const historyCopy = reliabilityCopy[locale].history;
			expect(historyCopy.partial).toBeTruthy();
			expect(historyCopy.currentOnly).toBeTruthy();
			expect(historyCopy.correction.malformed).toBeTruthy();
		}
		expect(reliabilityCopy.en.controls.activeWindow.range(1, window.from, window.to)).toContain(
			'1 day,',
		);
		expect(reliabilityCopy.fr.controls.activeWindow.range(1, window.from, window.to)).toContain(
			'1 jour,',
		);
	});
});

historyViewContract('line', {
	page: harness.page,
	index: harness.getLineHistoryIndex,
	range: harness.loadLineHistoryRange,
	entityId,
	partitions: retainedPartitions,
	mount: () => {
		const history = createHistory();
		const view = render(RouteReliabilityClusters, {
			props: { data: current, locale: 'en', history },
		});
		return { container: view.container, destroy: () => history.destroy() };
	},
	owned: {
		read: (container) => container.querySelector('[data-band="verdict"]')?.textContent ?? '',
		current: '12%',
		retained: '83%',
	},
	pending: (container) => {
		expect(container.querySelector('[data-slot="cancellations"]')?.textContent ?? '').not.toContain(
			'99',
		);
		expectMultiDayCaption(container);
		expectAnnounced(container, reliabilityCopy.en.history.loading);
	},
	loaded: (container) => {
		expectAnnounced(container, 'Retained range loaded.');
		expect(container.querySelector('[data-slot="cancellations"]')).toHaveTextContent('10.0%');
		expect(container.querySelector('[data-slot="skipped-stops"]')).toHaveTextContent('2.0%');
		expect(container.querySelector('[data-slot="service-completeness"]')).toHaveTextContent(
			'75.0%',
		);
		expect(harness.page.url.searchParams.get('tab')).toBe('reliability');
	},
});
