vi.mock('$app/navigation', () => ({ afterNavigate: () => {} }));
import { historyViewContract } from '#lib/features/reliability/__fixtures__/historyViewContract.ts';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '#lib/i18n/index.ts';
import type { StopReliability } from '#lib/v1/index.ts';
import { historyRangeRequestFromSearchParams } from '#lib/v1/history/rangeResource.svelte.ts';
import { encodeHistoryEntityId } from '#lib/v1/history/entity.ts';
import {
	HistoricCollectionIndexSchema,
	StopHistoryPartitionSchema,
	type HistoricCollectionIndex,
	type HistoricMetricCoverage,
	type HistoricPartitionRef,
	type IsoUtc,
	type StopHistoryPartition,
} from '#lib/v1/schemas/index.ts';
import {
	createStopHistoryResource,
	type StopHistoryResource,
} from '../data/stopHistoryResource.svelte';
import { stopReliabilityCopy } from '../stops-reliability.copy';
import StopReliabilitySurface from './StopReliabilitySurface.svelte';

const harness = vi.hoisted(() => {
	const page = {
		url: new URL('http://localhost/stop/raw?tab=reliability'),
		state: {},
	};
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
		getStopHistoryIndex: vi.fn(),
		loadStopHistoryRange: vi.fn(),
	};
});

vi.mock('$app/state', () => ({ page: harness.page }));
vi.mock('#lib/site/urlMirror.ts', () => ({
	mirrorSearchParams: harness.mirrorSearchParams,
	mirrorSearchParam: vi.fn(),
}));
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getStopHistoryIndex: harness.getStopHistoryIndex,
	loadStopHistoryRange: harness.loadStopHistoryRange,
}));

const ENTITY_ID = '../A/B?é';
const GENERATED = '2026-07-13T12:00:00Z' as IsoUtc;
const GENERATION = 'c'.repeat(64);
const WINDOW = { from: '2026-01-31', to: '2026-02-01' } as const;

function metric(
	name: HistoricMetricCoverage['metric'],
	aggregation: HistoricMetricCoverage['aggregation'],
	from: string | null = WINDOW.from,
	to: string | null = WINDOW.to,
): HistoricMetricCoverage {
	return {
		metric: name,
		aggregation,
		first_available_date: from,
		last_available_date: to,
		gaps: [],
	};
}

function partitionRef(
	month: string,
	shaCharacter: string,
	from: string,
	to: string,
): HistoricPartitionRef {
	const sha256 = shaCharacter.repeat(64);
	return {
		path: `historic/history/stops/${encodeHistoryEntityId(ENTITY_ID)}/generations/${sha256}/${month}.json`,
		coverage_start: from,
		coverage_end: to,
		count: 1,
		sha256,
		byte_size: 100,
	};
}

const refs = [
	partitionRef('2026-01', 'a', WINDOW.from, WINDOW.from),
	partitionRef('2026-02', 'b', WINDOW.to, WINDOW.to),
];

function collectionIndex(metrics: readonly HistoricMetricCoverage[]): HistoricCollectionIndex {
	return HistoricCollectionIndexSchema.parse({
		generated_utc: GENERATED,
		family: 'stops',
		selection_mode: 'range',
		entity_id: ENTITY_ID,
		collection_generation_id: GENERATION,
		first_available_date: WINDOW.from,
		last_available_date: WINDOW.to,
		gaps: [],
		partitions: refs,
		metrics,
	});
}

const completeIndex = collectionIndex([
	metric('delay', 'additive'),
	metric('delay_percentiles', 'daily_only'),
	metric('occupancy', 'additive'),
]);

const partialOccupancyIndex = collectionIndex([
	metric('delay', 'additive'),
	metric('delay_percentiles', 'daily_only'),
	metric('occupancy', 'additive', WINDOW.from, WINDOW.from),
]);

const noDelayIndex = collectionIndex([metric('delay_percentiles', 'daily_only')]);

function partition(month: string, days: Array<Record<string, unknown>>): StopHistoryPartition {
	return StopHistoryPartitionSchema.parse({
		generated_utc: GENERATED,
		month,
		entity_id: ENTITY_ID,
		days,
	});
}

function retainedDay(
	date: string,
	observations: number,
	severe: number,
	sumDelaySeconds: number,
	occupancy: Record<'empty' | 'many_seats' | 'few_seats' | 'standing' | 'full', number> | null,
) {
	return {
		date,
		delay: {
			observation_count: observations,
			in_clamp_observation_count: observations,
			severe_count: severe,
			sum_delay_seconds: sumDelaySeconds,
		},
		delay_percentiles: {
			observation_count: observations,
			p50_delay_seconds: 30,
			p90_delay_seconds: 180,
		},
		...(occupancy == null ? {} : { occupancy }),
	};
}

const retainedPartitions = [
	partition('2026-01', [
		retainedDay(WINDOW.from, 40, 0, 2_758, {
			empty: 0,
			many_seats: 5,
			few_seats: 3,
			standing: 2,
			full: 0,
		}),
	]),
	partition('2026-02', [
		retainedDay(WINDOW.to, 60, 9, 3_776, {
			empty: 0,
			many_seats: 5,
			few_seats: 3,
			standing: 2,
			full: 0,
		}),
	]),
] as StopHistoryPartition[];

const partialOccupancyPartitions = [
	retainedPartitions[0],
	partition('2026-02', [retainedDay(WINDOW.to, 60, 9, 3_776, null)]),
] as StopHistoryPartition[];

const zeroDelayPartitions = [
	partition('2026-01', [
		retainedDay(WINDOW.from, 40, 0, 0, {
			empty: 1,
			many_seats: 0,
			few_seats: 0,
			standing: 0,
			full: 0,
		}),
	]),
	partition('2026-02', [
		retainedDay(WINDOW.to, 60, 0, 0, {
			empty: 1,
			many_seats: 0,
			few_seats: 0,
			standing: 0,
			full: 0,
		}),
	]),
] as StopHistoryPartition[];

const noDelayPartitions = [
	partition('2026-01', [
		{
			date: WINDOW.from,
			delay_percentiles: {
				observation_count: 40,
				p50_delay_seconds: 0,
				p90_delay_seconds: 0,
			},
		},
	]),
	partition('2026-02', [
		{
			date: WINDOW.to,
			delay_percentiles: {
				observation_count: 60,
				p50_delay_seconds: 0,
				p90_delay_seconds: 0,
			},
		},
	]),
] as StopHistoryPartition[];

const habits = Array.from({ length: 7 }, (_, day) =>
	Array.from({ length: 24 }, (_, hour) => (day === 0 && hour === 8 ? 0.75 : null)),
);

const current: StopReliability = {
	generated_utc: GENERATED,
	id: ENTITY_ID,
	name: 'Current stop',
	periods: [
		{
			grain: 'day',
			otp_pct: 77,
			avg_delay_min: 7.7,
			p50_min: 2.5,
			p90_min: 12,
			severe_pct: 23,
			observation_count: 100,
		},
		{
			grain: 'week',
			otp_pct: 22,
			avg_delay_min: 6.6,
			severe_pct: 31,
			observation_count: 100,
		},
		{
			grain: 'month',
			otp_pct: 33,
			avg_delay_min: 5.5,
			severe_pct: 29,
			observation_count: 100,
		},
		{ grain: 'am_peak', severe_pct: 44, avg_delay_min: 4.4 },
		{ grain: 'weekday', severe_pct: 31, avg_delay_min: 3.1 },
	],
	habits: { scale: 'severe_relative', matrix: habits },
	day_of_week: [{ day_of_week_iso: 1, avg_delay_min: 8.8, severe_pct: 45 }],
	by_route: [{ route: '51', avg_delay_min: 8.8 }],
	occupancy_mix: { empty: 0, many_seats: 0, few_seats: 0, standing: 0, full: 1 },
	daily: [
		{
			date: '2026-07-11',
			observation_count: 40,
			severe_count: 40,
			severe_pct: 100,
			avg_delay_min: 9,
		},
		{
			date: '2026-07-12',
			observation_count: 60,
			severe_count: 59,
			severe_pct: 98.3,
			avg_delay_min: 9,
		},
	],
};

function explicitUrl(extra = ''): URL {
	return new URL(
		`http://localhost/stop/${encodeURIComponent(ENTITY_ID)}?tab=reliability&grain=week&from=${WINDOW.from}&to=${WINDOW.to}&focus=keep${extra}`,
	);
}

const resources: StopHistoryResource[] = [];

function createHistory(): StopHistoryResource {
	const resource = createStopHistoryResource(
		ENTITY_ID,
		historyRangeRequestFromSearchParams(harness.page.url.searchParams),
	);
	resources.push(resource);
	return resource;
}

function renderSurface(history: StopHistoryResource, locale: Locale = 'en') {
	return render(StopReliabilitySurface, {
		props: { data: current, locale, history } as never,
	});
}

function expectAnnounced(container: HTMLElement, message: RegExp | string): void {
	const statuses = [...container.querySelectorAll<HTMLElement>('[role="status"]')];
	const matches = statuses.some((status) =>
		typeof message === 'string'
			? status.textContent?.includes(message)
			: message.test(status.textContent ?? ''),
	);
	expect.soft(matches).toBe(true);
}

beforeEach(() => {
	harness.page.url = new URL(
		`http://localhost/stop/${encodeURIComponent(ENTITY_ID)}?tab=reliability`,
	);
	harness.mirrorSearchParams.mockClear();
	harness.getStopHistoryIndex.mockReset().mockResolvedValue(completeIndex);
	harness.loadStopHistoryRange.mockReset().mockResolvedValue(retainedPartitions);
});

afterEach(() => {
	for (const resource of resources.splice(0)) resource.destroy();
	cleanup();
});

describe('StopReliabilitySurface retained Stop history', () => {
	it.each(['en', 'fr'] as const)(
		'shows the selected raw daily percentiles and their own sample in %s',
		async (locale) => {
			harness.page.url = explicitUrl();
			harness.page.url.searchParams.set('to', WINDOW.from);
			harness.loadStopHistoryRange.mockResolvedValue([retainedPartitions[0]]);
			const history = createHistory();
			const view = renderSurface(history, locale);
			await waitFor(() => expect(history.state).toBe('ready'));
			const detail = view.container.querySelector('[data-slot="stop-percentiles"]');
			expect(detail).toHaveTextContent('0.5 min');
			expect(detail).toHaveTextContent('3.0 min');
			expect(detail).toHaveTextContent(
				locale === 'fr' ? 'Écart p90 − médiane : 2,5 min.' : 'p90 − median spread: 2.5 min.',
			);
			expect(detail).toHaveTextContent('2026-01-31 · 40');
			expect(detail).not.toHaveTextContent(stopReliabilityCopy[locale].scope.latestDay);
			expect(harness.loadStopHistoryRange).toHaveBeenCalledTimes(1);
		},
	);

	it('uses one controlled navigator in the existing rail, keeps three grains, and removes the local picker', async () => {
		harness.page.url = explicitUrl();
		const history = createHistory();
		const view = renderSurface(history);

		await waitFor(() => expect(history.state).toBe('ready'));
		expect(view.container.querySelectorAll('[data-slot="surface-rail"]')).toHaveLength(1);
		const rail = view.container.querySelector('[data-slot="surface-rail"]') as HTMLElement;
		expect(within(rail).getAllByRole('radio', { name: /Day|Week|Month/ })).toHaveLength(3);
		expect(within(rail).getAllByRole('region', { name: /stop reliability history/i })).toHaveLength(
			1,
		);
		const bounds = rail.querySelectorAll<HTMLInputElement>('input[type="date"]');
		expect(bounds).toHaveLength(2);
		expect(bounds[0]).toHaveValue(WINDOW.from);
		expect(bounds[1]).toHaveValue(WINDOW.to);
		expect(view.container.querySelector('[data-slot="daily-range-controls"]')).toBeNull();
		expect(view.container.querySelectorAll('[data-slot="date-range"]')).toHaveLength(1);
	});

	it('announces partial occupancy while rendering the retained mix', async () => {
		harness.page.url = explicitUrl();
		harness.getStopHistoryIndex.mockResolvedValue(partialOccupancyIndex);
		harness.loadStopHistoryRange.mockResolvedValue(partialOccupancyPartitions);
		const history = createHistory();
		const view = renderSurface(history);

		await waitFor(() => expect(history.state).toBe('partial'));
		expectAnnounced(view.container, /partial retained metric coverage/i);
		const crowding = view.container.querySelector('[data-slot="stop-crowding"]');
		expect(crowding).toHaveTextContent('50%');
		expect(crowding).not.toHaveTextContent('100%');
		expect(crowding).toHaveTextContent(/selected range/i);
		expect(crowding).not.toHaveTextContent(/last 30 days/i);
	});

	it.each([
		['en', /current snapshot/i],
		['fr', /portrait actuel/i],
	] as const)(
		'keeps current-only period, habits, weekday, time, and route sections with %s scope labels',
		async (locale, localizedScope) => {
			harness.page.url = explicitUrl();
			const history = createHistory();
			const view = renderSurface(history, locale);

			await waitFor(() => expect(history.state).toBe('ready'));
			for (const slot of [
				'stop-reliability-pane',
				'stop-habits',
				'stop-weekday',
				'stop-time-of-day',
				'stop-by-route',
			]) {
				expect.soft(view.container.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
			}
			const predictionPane = view.container.querySelector('[data-slot="stop-reliability-pane"]');
			expect(predictionPane).toHaveTextContent(locale === 'en' ? '31%' : '31 %');
			expect(predictionPane?.querySelector('[data-slot="prediction-scope"]')).toHaveTextContent(
				localizedScope,
			);
			expect(view.container.querySelector('[data-slot="stop-by-route"]')).toHaveTextContent('51');
			const scope = view.container.querySelectorAll('[data-slot="history-current-only"]');
			expect(scope).toHaveLength(1);
			expect(scope[0]).toHaveTextContent(localizedScope);
			for (const link of view.container.querySelectorAll<HTMLAnchorElement>('a[href^="/lines/"]')) {
				expect(link.getAttribute('href')).not.toMatch(/[?&](?:tab|grain|from|to)=/);
			}
		},
	);

	it('announces a retained-range error and retries through the real resource', async () => {
		harness.page.url = explicitUrl();
		harness.loadStopHistoryRange
			.mockRejectedValueOnce(new Error('retained range unavailable'))
			.mockResolvedValueOnce(retainedPartitions);
		const history = createHistory();
		const view = renderSurface(history);

		await waitFor(() => expect(history.state).toBe('error'));
		expectAnnounced(view.container, /retained range could not be loaded/i);
		// Day by day says the range failed: no endless loading line, no row standing in for it.
		const days = view.container.querySelector('#stop-rel-trend') as HTMLElement;
		expect(days).toHaveTextContent('This retained range could not be loaded.');
		expect(days).not.toHaveTextContent('Loading retained range');
		expect(days.querySelector('[data-slot="stop-daily"]')).toBeNull();
		const retry = view.queryByRole('button', { name: /retry/i });
		expect.soft(retry).not.toBeNull();
		if (retry) {
			await fireEvent.click(retry);
			await waitFor(() => expect(harness.loadStopHistoryRange).toHaveBeenCalledTimes(2));
			await waitFor(() => expect(history.state).toBe('ready'));
		}
	});

	it('gives a corrected range exactly one visual owner', async () => {
		harness.page.url = new URL(
			`http://localhost/stop/${encodeURIComponent(ENTITY_ID)}?tab=reliability&grain=week&from=2025-01-01&to=2025-01-02`,
		);
		const history = createHistory();
		const view = renderSurface(history);

		await waitFor(() => expect(history.state).toBe('current'));
		const owners = Array.from(
			view.container.querySelectorAll(
				'[data-slot="history-announcement"], [data-slot="history-correction"]',
			),
		).filter((element) =>
			/unavailable date range|plage non disponible/i.test(element.textContent ?? ''),
		);
		expect(owners).toHaveLength(1);
		expect(harness.page.url.searchParams.get('grain')).toBe('week');
		expect(harness.page.url.searchParams.get('from')).toBeNull();
		expect(harness.page.url.searchParams.get('to')).toBeNull();
	});

	it('keeps current singleton controls and data when the optional retained index is absent', async () => {
		harness.page.url = new URL(
			`http://localhost/stop/${encodeURIComponent(ENTITY_ID)}?tab=reliability&grain=week&from=2026-07-11&to=2026-07-11&focus=keep`,
		);
		harness.getStopHistoryIndex.mockResolvedValue(null);
		const history = createHistory();
		const view = renderSurface(history);

		await waitFor(() => expect(history.state).toBe('current'));
		const rail = view.container.querySelector('[data-slot="surface-rail"]') as HTMLElement;
		expect(within(rail).getAllByRole('region', { name: /stop reliability history/i })).toHaveLength(
			1,
		);
		const bounds = rail.querySelectorAll<HTMLInputElement>('input[type="date"]');
		expect(bounds).toHaveLength(2);
		expect(bounds[0]).toHaveValue('2026-07-11');
		expect(bounds[1]).toHaveValue('2026-07-11');
		// The one chosen day, from the current file: one row, its own share.
		const days = view.container.querySelectorAll('[data-slot="stop-daily"] tbody tr');
		expect(days).toHaveLength(1);
		expect(days[0]).toHaveTextContent('100%');
		expect(harness.loadStopHistoryRange).not.toHaveBeenCalled();
		expect(harness.page.url.searchParams.get('from')).toBe('2026-07-11');
		expect(harness.page.url.searchParams.get('to')).toBe('2026-07-11');
		expect(harness.page.url.searchParams.get('grain')).toBe('week');
		expect(harness.page.url.searchParams.get('tab')).toBe('reliability');
		expect(harness.page.url.searchParams.get('focus')).toBe('keep');
	});

	it('keeps a measured zero severe share distinct from retained no-delay data', async () => {
		harness.page.url = explicitUrl();
		harness.loadStopHistoryRange.mockResolvedValue(zeroDelayPartitions);
		const zeroHistory = createHistory();
		const zeroView = renderSurface(zeroHistory);

		await waitFor(() => expect(zeroHistory.state).toBe('ready'));
		const zeroDays = zeroView.container.querySelectorAll('[data-slot="stop-daily"] tbody tr');
		expect(Array.from(zeroDays, (row) => row.children[1]?.textContent)).toEqual(['0%', '0%']);

		cleanup();
		harness.getStopHistoryIndex.mockResolvedValue(noDelayIndex);
		harness.loadStopHistoryRange.mockResolvedValue(noDelayPartitions);
		const noDataHistory = createHistory();
		const noDataView = renderSurface(noDataHistory);
		await waitFor(() => expect(noDataHistory.state).toBe('no-data'));
		expectAnnounced(noDataView.container, /no data is retained for this range/i);
		const noDays = noDataView.container.querySelector('[data-slot="stop-daily"] tbody');
		expect(noDays?.textContent ?? '').not.toContain('0%');
		expect(noDays).toHaveTextContent('Not published');
	});

	it('defines honest Stop-history navigation, state, correction, and current-only copy in EN and FR', () => {
		type HistoryCopy = {
			navigator?: { group?: string };
			partial?: string;
			currentOnly?: string;
			loading?: string;
			error?: string;
			retry?: string;
			correction?: Record<string, string>;
		};
		for (const locale of ['en', 'fr'] as const) {
			const historyCopy = (stopReliabilityCopy[locale] as unknown as { history?: HistoryCopy })
				.history;
			expect.soft(historyCopy).toBeDefined();
			expect.soft(historyCopy?.navigator?.group).toBeTruthy();
			expect.soft(historyCopy?.partial).toBeTruthy();
			expect.soft(historyCopy?.currentOnly).toBeTruthy();
			expect.soft(historyCopy?.loading).toBeTruthy();
			expect.soft(historyCopy?.error).toBeTruthy();
			expect.soft(historyCopy?.retry).toBeTruthy();
			expect.soft(historyCopy?.correction?.malformed).toBeTruthy();
			expect.soft(historyCopy?.correction?.['outside-coverage']).toBeTruthy();
		}
	});
});

describe('StopReliabilitySurface figure periods', () => {
	const ALL_HISTORY_SECTIONS = ['stop-rel-habits', 'stop-rel-weekday', 'stop-rel-time'];
	const scopeIn = (container: HTMLElement, id: string) =>
		container.querySelector(`#${id} [data-slot="all-history-scope"]`);

	it.each([
		[
			'en',
			'Latest complete day',
			'All available history: Jan 31, 2026 to Feb 1, 2026. These figures do not change with the selected dates.',
		],
		[
			'fr',
			'Dernier jour complet',
			'Tout l’historique disponible : du 31 janv. 2026 au 1 févr. 2026. Ces chiffres ne changent pas avec les dates choisies.',
		],
	] as const)(
		'names the period of each figure the dates do not change (%s)',
		async (locale, day, all) => {
			harness.page.url.searchParams.set('grain', 'day');
			const history = createHistory();
			const view = renderSurface(history, locale);
			await waitFor(() => expect(history.index).not.toBeNull());

			expect(view.container.querySelector('[data-slot="stop-percentiles"]')).toHaveTextContent(day);
			for (const id of ALL_HISTORY_SECTIONS)
				expect(scopeIn(view.container, id)).toHaveTextContent(all);
			for (const id of [
				'stop-rel-trend',
				'stop-rel-pane',
				'stop-rel-crowding',
				'stop-rel-by-route',
			]) {
				expect(scopeIn(view.container, id)).toBeNull();
			}
		},
	);

	it('claims no history dates when the retained index is absent', async () => {
		harness.getStopHistoryIndex.mockResolvedValue(null);
		const history = createHistory();
		const view = renderSurface(history);
		await waitFor(() => expect(history.state).toBe('current'));

		expect(view.container.querySelector('[data-slot="all-history-scope"]')).toBeNull();
	});
});

historyViewContract('stop', {
	page: harness.page,
	index: harness.getStopHistoryIndex,
	range: harness.loadStopHistoryRange,
	entityId: ENTITY_ID,
	partitions: retainedPartitions,
	grain: 'week',
	mount: () => renderSurface(createHistory()),
	owned: {
		read: (container) =>
			container.querySelector('[data-slot="stop-daily"] tbody')?.textContent ?? '',
		current: '98.3%',
		retained: '15%',
	},
	current: (container) => {
		expect(container.querySelector('[data-slot="stop-crowding"]')).toHaveTextContent('100%');
		expect(container.querySelector('[data-slot="prediction-scope"]')).toBeNull();
	},
	pending: (container) => {
		expect(container.querySelector('[data-slot="stop-crowding"]')).toBeNull();
		expectAnnounced(container, /loading retained range/i);
	},
	loaded: (container) => {
		const days = Array.from(
			container.querySelectorAll('[data-slot="stop-daily"] tbody tr'),
			(row) => Array.from(row.children, (cell) => cell.textContent?.trim()),
		);
		expect(days).toEqual([
			['Saturday, January 31', '0%', '40', '0'],
			['Sunday, February 1', '15%', '60', '9'],
		]);
		expect(container.querySelector('[data-slot="day-by-day-scope"] li')).toHaveTextContent(
			'The dates you chose. The record above stays the published week.',
		);
		expect(
			container.querySelector('[data-slot="stop-reliability-pane"] [data-slot="verdict"]'),
		).toHaveTextContent('9%');
		expect(container.querySelector('[data-slot="prediction-scope"]')).toHaveTextContent(
			/verdict.*selected/i,
		);
		expect(harness.page.url.searchParams.get('grain')).toBe('week');
		expect(harness.page.url.searchParams.get('tab')).toBe('reliability');
	},
});
