import type {
	HistoricAvailabilityIndex,
	HistoricCoverageGap,
	HistoricFamilyAvailability,
	HistoricMetricCoverage,
	HistoryMetricAggregation,
	HistoryMetricName,
	HistorySelectionMode,
} from '#lib/v1/schemas/index.ts';
import {
	LINE_CURRENT_ONLY_SECTIONS,
	NETWORK_CURRENT_ONLY_SECTIONS,
	STOP_CURRENT_ONLY_SECTIONS,
} from '#lib/v1/history/families.ts';

const HISTORY_COVERAGE_FAMILIES = [
	'alerts',
	'receipts',
	'network',
	'lines',
	'stops',
	'hotspots',
	'repeat_offenders',
] as const;

export type HistoryCoverageFamilyKey = (typeof HISTORY_COVERAGE_FAMILIES)[number];

export interface HistoryCoverageGapView {
	readonly startDate: string;
	readonly endDate: string;
	readonly reason: string | null;
}

export interface HistoryCoverageMetricView {
	readonly key: HistoryMetricName;
	readonly aggregation: HistoryMetricAggregation;
	readonly firstDate: string | null;
	readonly lastDate: string | null;
	readonly gaps: readonly HistoryCoverageGapView[] | null;
}

/** Whole calendar days of one family's published window, from its first to its last date. */
export interface HistoryCoverageDays {
	readonly inWindow: number;
	/** Declared missing days inside the window; null when no readable gap list is published. */
	readonly missing: number | null;
	/** Days not declared missing: inWindow − missing. */
	readonly withRecords: number | null;
	/** Separate runs of missing days once overlapping or adjacent gaps are merged. */
	readonly gapRuns: number | null;
}

/** What can honestly be said about a family's dates; absence is never a count of zero. */
export type HistoryCoverageState =
	| 'unpublished'
	| 'no-dates'
	| 'unreadable-dates'
	| 'gaps-unknown'
	| 'no-gaps'
	| 'gaps';

export interface HistoryCoverageFamilyView {
	readonly key: HistoryCoverageFamilyKey;
	readonly published: boolean;
	readonly state: HistoryCoverageState;
	readonly days: HistoryCoverageDays | null;
	/** The collection run that produced this family's history, when published. */
	readonly collectionGenerationId: string | null;
	readonly selectionMode: HistorySelectionMode | null;
	readonly firstDate: string | null;
	readonly lastDate: string | null;
	readonly gaps: readonly HistoryCoverageGapView[] | null;
	readonly metrics: readonly HistoryCoverageMetricView[];
	readonly currentOnlySections: readonly string[];
}

function date(value: string | null | undefined): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function gaps(values: readonly HistoricCoverageGap[] | undefined): HistoryCoverageGapView[] | null {
	if (values === undefined) return null;
	return values.map((gap) => ({
		startDate: gap.start_date,
		endDate: gap.end_date,
		reason: gap.reason?.trim() || null,
	}));
}

function metrics(
	values: readonly HistoricMetricCoverage[] | undefined,
): HistoryCoverageMetricView[] {
	return (values ?? []).map((metric) => ({
		key: metric.metric,
		aggregation: metric.aggregation,
		firstDate: date(metric.first_available_date),
		lastDate: date(metric.last_available_date),
		gaps: gaps(metric.gaps),
	}));
}

function currentOnlySections(key: HistoryCoverageFamilyKey): readonly string[] {
	if (key === 'network') return NETWORK_CURRENT_ONLY_SECTIONS;
	if (key === 'lines') return LINE_CURRENT_ONLY_SECTIONS;
	if (key === 'stops') return STOP_CURRENT_ONLY_SECTIONS;
	return [];
}

const DAY_MS = 86_400_000;

/** A YYYY-MM-DD calendar date as a whole day number, or null when it is not a real date. */
function dayNumber(value: string | null | undefined): number | null {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const [year, month, day] = value.split('-').map(Number) as [number, number, number];
	const ms = Date.UTC(year, month - 1, day);
	return new Date(ms).toISOString().slice(0, 10) === value ? ms / DAY_MS : null;
}

function coverage(
	published: HistoricFamilyAvailability | undefined,
): Pick<HistoryCoverageFamilyView, 'state' | 'days'> {
	if (published === undefined) return { state: 'unpublished', days: null };
	if (!date(published.first_available_date) || !date(published.last_available_date))
		return { state: 'no-dates', days: null };
	const first = dayNumber(published.first_available_date);
	const last = dayNumber(published.last_available_date);
	if (first == null || last == null || last < first)
		return { state: 'unreadable-dates', days: null };
	const inWindow = last - first + 1;
	const unknown = { inWindow, missing: null, withRecords: null, gapRuns: null };
	// Each gap clipped to the window; one unreadable gap makes the whole count unknown.
	const runs: [number, number][] = [];
	for (const gap of published.gaps ?? []) {
		const start = dayNumber(gap.start_date);
		const end = dayNumber(gap.end_date);
		if (start == null || end == null || end < start)
			return { state: 'gaps-unknown', days: unknown };
		if (end >= first && start <= last) runs.push([Math.max(start, first), Math.min(end, last)]);
	}
	if (published.gaps === undefined) return { state: 'gaps-unknown', days: unknown };
	// Merge overlapping and adjacent runs so no day is counted twice.
	const merged: [number, number][] = [];
	for (const [start, end] of runs.sort((a, b) => a[0] - b[0])) {
		const previous = merged.at(-1);
		if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
		else merged.push([start, end]);
	}
	const missing = merged.reduce((sum, [start, end]) => sum + end - start + 1, 0);
	return {
		state: missing > 0 ? 'gaps' : 'no-gaps',
		days: { inWindow, missing, withRecords: inWindow - missing, gapRuns: merged.length },
	};
}

function row(
	key: HistoryCoverageFamilyKey,
	published: HistoricFamilyAvailability | undefined,
): HistoryCoverageFamilyView {
	const metricRows = metrics(published?.metrics);
	return {
		key,
		published: published !== undefined,
		...coverage(published),
		collectionGenerationId: published?.collection_generation_id?.trim() || null,
		selectionMode: published?.selection_mode ?? null,
		firstDate: date(published?.first_available_date),
		lastDate: date(published?.last_available_date),
		gaps: gaps(published?.gaps),
		metrics: metricRows,
		currentOnlySections: currentOnlySections(key),
	};
}

/** The history inventory's own stamp: it dates every family's window, not the daily record. */
export interface HistoryInventoryView {
	readonly publishedOn: string | null;
	readonly publishGenerationId: string | null;
	readonly methodologyVersion: string | null;
	readonly schemaVersion: number | null;
}

export function selectHistoryInventory(
	root: HistoricAvailabilityIndex | null | undefined,
): HistoryInventoryView | null {
	if (!root) return null;
	const day = String(root.generated_utc ?? '').slice(0, 10);
	return {
		publishedOn: dayNumber(day) == null ? null : day,
		publishGenerationId: root.publish_generation_id?.trim() || null,
		methodologyVersion: root.methodology_version?.trim() || null,
		schemaVersion: Number.isInteger(root.schema_version) ? root.schema_version! : null,
	};
}

export function selectHistoryCoverage(
	root: HistoricAvailabilityIndex | null | undefined,
): readonly HistoryCoverageFamilyView[] {
	const families = root?.families ?? [];
	if (families.length === 0) return [];

	return HISTORY_COVERAGE_FAMILIES.map((key) =>
		row(
			key,
			families.find((family) => family.family === key),
		),
	);
}
