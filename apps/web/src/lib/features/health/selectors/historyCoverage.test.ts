import { describe, expect, it } from 'vitest';
import type { HistoricAvailabilityIndex, IsoUtc } from '#lib/v1/schemas/index.ts';
import {
	LINE_CURRENT_ONLY_SECTIONS,
	NETWORK_CURRENT_ONLY_SECTIONS,
	STOP_CURRENT_ONLY_SECTIONS,
} from '#lib/v1/history/families.ts';
import { selectHistoryCoverage, selectHistoryInventory } from './historyCoverage';

const iso = (value: string) => value as unknown as IsoUtc;

function root(
	families: NonNullable<HistoricAvailabilityIndex['families']>,
): HistoricAvailabilityIndex {
	return { generated_utc: iso('2026-07-14T12:00:00Z'), families };
}

describe('selectHistoryCoverage', () => {
	it('orders the seven public families and preserves their real windows, gaps, and metric semantics', () => {
		const rows = selectHistoryCoverage(
			root([
				{
					family: 'network',
					selection_mode: 'range',
					index_path: 'historic/history/network/index.json',
					first_available_date: '2026-05-01',
					last_available_date: '2026-07-13',
					gaps: [
						{
							start_date: '2026-06-02',
							end_date: '2026-06-03',
							reason: 'source outage',
						},
					],
					metrics: [
						{
							metric: 'delay',
							aggregation: 'additive',
							first_available_date: '2026-05-01',
							last_available_date: '2026-07-13',
							gaps: [],
						},
						{
							metric: 'delay_percentiles',
							aggregation: 'daily_only',
							first_available_date: '2026-05-05',
							last_available_date: '2026-07-12',
							gaps: [{ start_date: '2026-06-10', end_date: '2026-06-10', reason: null }],
						},
						{
							metric: 'vehicles',
							aggregation: 'daily_only',
							first_available_date: '2026-05-01',
							last_available_date: '2026-07-13',
						},
					],
				},
				{
					family: 'repeat_offenders',
					selection_mode: 'date',
					index_path: 'historic/history/repeat_offenders/index.json',
					first_available_date: '2026-06-01',
					last_available_date: '2026-07-13',
				},
				{
					family: 'alerts',
					selection_mode: 'range',
					index_path: 'historic/alerts/index.json',
					first_available_date: '2026-05-20',
					last_available_date: '2026-07-14',
				},
				{
					family: 'receipts',
					selection_mode: 'date',
					index_path: 'historic/receipts/index.json',
					first_available_date: '2026-06-12',
					last_available_date: '2026-07-13',
				},
				{
					family: 'lines',
					selection_mode: 'range',
					index_path: 'historic/history/lines/index.json',
					first_available_date: '2026-05-01',
					last_available_date: '2026-07-13',
				},
				{
					family: 'stops',
					selection_mode: 'range',
					index_path: 'historic/history/stops/index.json',
					first_available_date: '2026-05-08',
					last_available_date: '2026-07-13',
				},
				{
					family: 'hotspots',
					selection_mode: 'date',
					index_path: 'historic/history/hotspots/index.json',
					first_available_date: '2026-06-01',
					last_available_date: '2026-07-13',
				},
			]),
		);

		expect(rows.map((row) => row.key)).toEqual([
			'alerts',
			'receipts',
			'network',
			'lines',
			'stops',
			'hotspots',
			'repeat_offenders',
		]);
		expect(rows[2]).toMatchObject({
			published: true,
			selectionMode: 'range',
			firstDate: '2026-05-01',
			lastDate: '2026-07-13',
			gaps: [{ startDate: '2026-06-02', endDate: '2026-06-03', reason: 'source outage' }],
			currentOnlySections: [...NETWORK_CURRENT_ONLY_SECTIONS],
			metrics: [
				{
					key: 'delay',
					aggregation: 'additive',
					firstDate: '2026-05-01',
					lastDate: '2026-07-13',
					gaps: [],
				},
				{
					key: 'delay_percentiles',
					aggregation: 'daily_only',
					firstDate: '2026-05-05',
					lastDate: '2026-07-12',
					gaps: [{ startDate: '2026-06-10', endDate: '2026-06-10', reason: null }],
				},
				{
					key: 'vehicles',
					aggregation: 'daily_only',
					firstDate: '2026-05-01',
					lastDate: '2026-07-13',
					gaps: null,
				},
			],
		});
		expect(rows[3]?.currentOnlySections).toEqual([...LINE_CURRENT_ONLY_SECTIONS]);
		expect(rows[4]?.currentOnlySections).toEqual([...STOP_CURRENT_ONLY_SECTIONS]);
		expect(rows[0]?.currentOnlySections).toEqual([]);
	});

	it('keeps missing expected families as honest unavailable rows once a real root exists', () => {
		const rows = selectHistoryCoverage(
			root([
				{
					family: 'alerts',
					selection_mode: 'range',
					index_path: 'historic/alerts/index.json',
				},
			]),
		);

		expect(rows).toHaveLength(7);
		expect(rows[0]).toMatchObject({ key: 'alerts', published: true });
		expect(rows[1]).toMatchObject({
			key: 'receipts',
			published: false,
			selectionMode: null,
			firstDate: null,
			lastDate: null,
			gaps: null,
			metrics: [],
		});
	});

	it('marks live vehicles current-only only when that exact published metric says so', () => {
		const base = {
			family: 'network',
			selection_mode: 'range' as const,
			index_path: 'historic/history/network/index.json',
		};
		const daily = selectHistoryCoverage(
			root([{ ...base, metrics: [{ metric: 'vehicles', aggregation: 'daily_only' }] }]),
		);
		const current = selectHistoryCoverage(
			root([{ ...base, metrics: [{ metric: 'vehicles', aggregation: 'current_only' }] }]),
		);

		expect(
			daily
				.find((row) => row.key === 'network')
				?.metrics.find((metric) => metric.key === 'vehicles')?.aggregation,
		).toBe('daily_only');
		expect(
			current
				.find((row) => row.key === 'network')
				?.metrics.find((metric) => metric.key === 'vehicles')?.aggregation,
		).toBe('current_only');
	});

	it('counts the days a family covers, merging and clipping its declared gaps', () => {
		const network = (patch: object) =>
			selectHistoryCoverage(
				root([
					{
						family: 'network',
						selection_mode: 'range',
						index_path: 'historic/history/network/index.json',
						...patch,
					},
				]),
			)[2];
		const counted = network({
			first_available_date: '2026-05-01',
			last_available_date: '2026-07-13',
			gaps: [{ start_date: '2026-06-02', end_date: '2026-06-03', reason: 'outage' }],
			collection_generation_id: 'collection-7',
		});
		// Across a daylight-saving change; overlapping, adjacent and outside gaps.
		const overlapping = network({
			first_available_date: '2026-03-01',
			last_available_date: '2026-03-10',
			gaps: [
				{ start_date: '2026-03-04', end_date: '2026-03-05' },
				{ start_date: '2026-02-25', end_date: '2026-03-01' },
				{ start_date: '2026-03-02', end_date: '2026-03-04' },
				{ start_date: '2026-03-20', end_date: '2026-03-25' },
			],
		});

		expect(counted).toMatchObject({
			state: 'gaps',
			collectionGenerationId: 'collection-7',
			days: { inWindow: 74, missing: 2, withRecords: 72, gapRuns: 1 },
		});
		expect(overlapping).toMatchObject({
			state: 'gaps',
			collectionGenerationId: null,
			days: { inWindow: 10, missing: 5, withRecords: 5, gapRuns: 1 },
		});
	});

	it('never turns an absent, unreadable or undeclared gap list into a count', () => {
		const family = {
			family: 'lines',
			selection_mode: 'range' as const,
			index_path: 'historic/history/lines/index.json',
			first_available_date: '2026-06-01',
			last_available_date: '2026-06-30',
		};
		const row = (patch: Record<string, unknown>) =>
			selectHistoryCoverage(root([{ ...family, ...patch }]))[3]!;
		const window = { inWindow: 30, missing: null, withRecords: null, gapRuns: null };

		expect(row({ gaps: [] })).toMatchObject({
			state: 'no-gaps',
			days: { inWindow: 30, missing: 0, withRecords: 30, gapRuns: 0 },
		});
		expect(row({})).toMatchObject({ state: 'gaps-unknown', days: window });
		for (const gap of [
			{ start_date: '2026-06-09', end_date: '2026-06-08' },
			{ start_date: '2026-06-31', end_date: '2026-06-31' },
			{ start_date: 'June 9', end_date: '2026-06-09' },
		])
			expect(row({ gaps: [gap] })).toMatchObject({ state: 'gaps-unknown', days: window });
		expect(row({ first_available_date: null })).toMatchObject({ state: 'no-dates', days: null });
		for (const dates of [
			{ last_available_date: '2026-05-31' },
			{ first_available_date: '2026-02-30' },
		])
			expect(row(dates)).toMatchObject({ state: 'unreadable-dates', days: null });
		expect(selectHistoryCoverage(root([family]))[2]).toMatchObject({
			state: 'unpublished',
			days: null,
		});
	});

	it('keeps every day count whole, in range and equal to the sum of its parts', () => {
		// A small seeded generator replaces a committed fixture; a day-by-day count is the oracle.
		let seed = 20261115;
		const next = (n: number) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
		const day = (offset: number) =>
			new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
		for (let run = 0; run < 300; run += 1) {
			const first = next(400);
			const last = first + next(60);
			const gaps = Array.from({ length: next(6) }, () => {
				const start = first - 5 + next(last - first + 10);
				return { start_date: day(start), end_date: day(start + next(8)) };
			});
			const [row] = selectHistoryCoverage(
				root([
					{
						family: 'alerts',
						selection_mode: 'range',
						index_path: 'historic/alerts/index.json',
						first_available_date: day(first),
						last_available_date: day(last),
						gaps,
					},
				]),
			);
			const missingDays = new Set<number>();
			for (let offset = first; offset <= last; offset += 1)
				if (gaps.some((gap) => gap.start_date <= day(offset) && day(offset) <= gap.end_date))
					missingDays.add(offset);
			const days = row!.days!;
			const numbers = [days.inWindow, days.missing, days.withRecords, days.gapRuns] as number[];

			expect(numbers.every((n) => Number.isInteger(n) && n >= 0 && !Object.is(n, -0))).toBe(true);
			expect(days.inWindow).toBe(last - first + 1);
			expect(days.missing).toBe(missingDays.size);
			expect(days.withRecords! + days.missing!).toBe(days.inWindow);
			expect(days.withRecords).toBeLessThanOrEqual(days.inWindow);
			expect(days.gapRuns).toBeLessThanOrEqual(days.missing!);
			expect(row!.state).toBe(missingDays.size > 0 ? 'gaps' : 'no-gaps');
		}
	});

	it('names the history inventory that dates every family', () => {
		expect(
			selectHistoryInventory({
				generated_utc: iso('2026-07-14T12:00:00Z'),
				publish_generation_id: 'gen-history',
				methodology_version: 'historic-2',
				schema_version: 1,
				families: [],
			}),
		).toEqual({
			publishedOn: '2026-07-14',
			publishGenerationId: 'gen-history',
			methodologyVersion: 'historic-2',
			schemaVersion: 1,
		});
		expect(selectHistoryInventory({ generated_utc: iso('') })).toEqual({
			publishedOn: null,
			publishGenerationId: null,
			methodologyVersion: null,
			schemaVersion: null,
		});
		expect(selectHistoryInventory(null)).toBeNull();
	});

	it('stands down for a missing or legacy root with no family inventory', () => {
		expect(selectHistoryCoverage(null)).toEqual([]);
		expect(selectHistoryCoverage(undefined)).toEqual([]);
		expect(selectHistoryCoverage(root([]))).toEqual([]);
		expect(selectHistoryCoverage({ generated_utc: iso('2026-07-14T12:00:00Z') })).toEqual([]);
	});
});
