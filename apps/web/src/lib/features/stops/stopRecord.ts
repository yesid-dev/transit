import { intl, type Locale } from '#lib/i18n/index.ts';
import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
import { fmtLocalePct } from '#lib/utils/format.ts';
import { createPublishedWeeklyRanking } from '#lib/v1/ranking/published.ts';
import { RouteReliabilityIndexSchema } from '#lib/v1/schemas/route_reliability_index.ts';
import { detailCopy } from './stops.copy';

/**
 * The stop record's answer: the stop's row in the published weekly ranking, the same row the
 * home page's "Most delayed stops" reads, presented with its measure, period and evidence.
 * Absent, failed, out-of-date and unranked rows stay distinct states and never show a figure.
 */

export interface StopRecordInput {
	readonly stopId: string;
	/** The published reliability index resource (`getPublishedReliabilityIndex`). */
	readonly index: { readonly data: unknown; readonly error: unknown; readonly settled: boolean };
	/** Server-aligned now, in epoch milliseconds: the ranking's own currency rule uses it. */
	readonly now: number;
}

/** Who and where, for the CSV row and the citation. */
export interface StopRecordContext {
	readonly operator: string;
	readonly stopId: string;
	readonly stopCode: string | null;
	readonly stopName: string;
	readonly url: string;
}

export type StopRecordState =
	| 'pending'
	| 'failed'
	| 'unpublished'
	| 'not-current'
	| 'not-listed'
	| 'unmeasured'
	| 'measured';

export interface StopRecordShare {
	readonly readings: number;
	readonly lateReadings: number;
	/** Percentage points in [0, 100], one decimal, as published. */
	readonly latePct: number;
	readonly windowStart: string;
	readonly windowEnd: string;
}

export interface StopRecordView {
	readonly state: StopRecordState;
	readonly measure: string;
	/** "November 4 to 10, 2026 · 7 complete days" when the row names its window. */
	readonly period: string | null;
	/** The share as shown, e.g. "57.1%"; null whenever no share is published. */
	readonly figure: string | null;
	/** The words after the figure. */
	readonly sentence: string;
	/** The state sentence for every state without a figure. */
	readonly status: string | null;
	/** Always the same two rows; a value is null only while the record is loading. */
	readonly evidence: readonly { readonly label: string; readonly value: string | null }[];
	readonly share: StopRecordShare | null;
	readonly csv: { readonly filename: string; readonly text: string } | null;
	readonly citation: string | null;
}

type WeeklyRow = NonNullable<
	NonNullable<ReturnType<typeof RouteReliabilityIndexSchema.parse>['weekly_stops']>
>[number];

type Located =
	| { readonly state: Exclude<StopRecordState, 'unmeasured' | 'measured'> }
	| { readonly state: 'unmeasured'; readonly row: WeeklyRow }
	| { readonly state: 'measured'; readonly row: WeeklyRow; readonly share: StopRecordShare };

function locate({ stopId, index, now }: StopRecordInput): Located {
	if (index.data == null) {
		if (index.error != null) return { state: 'failed' };
		return { state: index.settled ? 'unpublished' : 'pending' };
	}
	const parsed = RouteReliabilityIndexSchema.safeParse(index.data);
	if (!parsed.success) return { state: 'failed' };
	if ((parsed.data.weekly_stops?.length ?? 0) === 0) return { state: 'unpublished' };
	// The home page's reader decides currency, so both pages show or withhold the same figure.
	const rows = createPublishedWeeklyRanking(index.data)('stop', now);
	if (rows == null) return { state: 'not-current' };
	const row = rows.find((candidate) => candidate.id === stopId);
	if (row == null) return { state: 'not-listed' };
	if (row.state !== 'ranked') return { state: 'unmeasured', row };
	const share = checkedShare(row);
	return share == null ? { state: 'failed' } : { state: 'measured', row, share };
}

/** Owner ruling 6: counts are whole and ordered, the share is bounded and agrees with them. */
function checkedShare(row: Extract<WeeklyRow, { state: 'ranked' }>): StopRecordShare | null {
	const readings = row.denominator;
	const lateReadings = row.denominator - row.numerator;
	const latePct = row.severe_pct;
	if (
		latePct == null ||
		!Number.isInteger(readings) ||
		!Number.isInteger(lateReadings) ||
		readings <= 0 ||
		lateReadings < 0 ||
		lateReadings > readings ||
		!Number.isFinite(latePct) ||
		latePct < 0 ||
		latePct > 100 ||
		Math.abs(latePct - (100 * lateReadings) / readings) > 0.05
	)
		return null;
	return {
		readings,
		lateReadings,
		latePct: latePct + 0, // no negative zero
		windowStart: row.window_start,
		windowEnd: row.window_end,
	};
}

function utcDate(key: string): Date {
	return new Date(`${key}T12:00:00Z`);
}

function datePart(key: string, locale: Locale, options: Intl.DateTimeFormatOptions): string {
	return intl.dateTime(locale, { ...options, timeZone: 'UTC' }).format(utcDate(key));
}

function dayOfMonth(key: string, locale: Locale): string {
	const day = Number(key.slice(8, 10));
	return locale === 'fr' && day === 1 ? '1er' : String(day);
}

/** "November 4 to 10, 2026" / "Du 4 au 10 novembre 2026", naming months and years only when they change. */
function periodRange(from: string, to: string, locale: Locale): string {
	const range = detailCopy[locale].record.range;
	const sameYear = from.slice(0, 4) === to.slice(0, 4);
	const sameMonth = sameYear && from.slice(5, 7) === to.slice(5, 7);
	const month = (key: string) => datePart(key, locale, { month: 'long' });
	const year = (key: string) => key.slice(0, 4);
	if (locale === 'fr') {
		const day = (key: string) => `${dayOfMonth(key, locale)} ${month(key)}`;
		if (!sameYear) return range(`${day(from)} ${year(from)}`, `${day(to)} ${year(to)}`);
		return range(sameMonth ? dayOfMonth(from, locale) : day(from), `${day(to)} ${year(to)}`);
	}
	const day = (key: string) => `${month(key)} ${dayOfMonth(key, locale)}`;
	if (!sameYear) return range(`${day(from)}, ${year(from)}`, `${day(to)}, ${year(to)}`);
	return range(day(from), `${sameMonth ? dayOfMonth(to, locale) : day(to)}, ${year(to)}`);
}

const WINDOW_DAYS = 7;

function period(row: WeeklyRow, locale: Locale): string {
	const days = transitTerms[locale].completeDays(
		WINDOW_DAYS,
		intl.number(locale).format(WINDOW_DAYS),
	);
	return detailCopy[locale].record.period(
		periodRange(row.window_start, row.window_end, locale),
		days,
	);
}

function csvCell(value: string | number): string {
	const text = String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvFor(share: StopRecordShare, context: StopRecordContext) {
	const header = [
		'operator',
		'stop_id',
		'stop_code',
		'stop_name',
		'measure',
		'window_start',
		'window_end',
		'readings',
		'late_readings',
		'late_share_pct',
	];
	const row = [
		context.operator,
		context.stopId,
		context.stopCode ?? '',
		context.stopName,
		'readings_more_than_5_min_late',
		share.windowStart,
		share.windowEnd,
		share.readings,
		share.lateReadings,
		share.latePct,
	];
	const slug = (value: string) =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
	return {
		filename: `transit-${slug(context.operator)}-stop-${slug(context.stopCode ?? context.stopId)}-${share.windowStart}-to-${share.windowEnd}.csv`,
		text: `${header.join(',')}\r\n${row.map(csvCell).join(',')}\r\n`,
	};
}

const UNMEASURED: Record<
	Exclude<WeeklyRow['state'], 'ranked'>,
	'tooFew' | 'noLiveData' | 'notMeasured'
> = {
	too_few_trips: 'tooFew',
	too_few_service_days: 'tooFew',
	too_few_units: 'tooFew',
	no_live_data: 'noLiveData',
	not_measured: 'notMeasured',
	not_defined: 'notMeasured',
};

const STATUS: Record<
	Exclude<StopRecordState, 'unmeasured' | 'measured'>,
	keyof typeof detailCopy.en.record
> = {
	pending: 'pending',
	failed: 'failed',
	unpublished: 'unpublished',
	'not-current': 'notCurrent',
	'not-listed': 'notListed',
};

export function presentStopRecord(
	input: StopRecordInput,
	locale: Locale,
	context: StopRecordContext,
): StopRecordView {
	const t = detailCopy[locale].record;
	const located = locate(input);
	const base = {
		state: located.state,
		measure: t.measure,
		sentence: t.sentence,
		figure: null,
		share: null,
		csv: null,
		citation: null,
		evidence: [
			{
				label: t.readingsLabel,
				value: located.state === 'pending' ? null : t.readingsUnpublished,
			},
			{ label: t.uncertaintyLabel, value: located.state === 'pending' ? null : t.uncertainty },
		],
	};
	if (located.state === 'measured') {
		const { share } = located;
		const count = (value: number) => intl.number(locale).format(value);
		const figure = fmtLocalePct(share.latePct, locale, { noData: '' });
		const range = periodRange(share.windowStart, share.windowEnd, locale);
		return {
			...base,
			period: period(located.row, locale),
			figure,
			status: null,
			share,
			evidence: [
				{
					label: t.readingsLabel,
					value: t.readings(count(share.readings), count(share.lateReadings)),
				},
				{ label: t.uncertaintyLabel, value: t.uncertainty },
			],
			csv: csvFor(share, context),
			citation: `${t.citation(
				context.operator,
				context.stopCode ?? context.stopId,
				context.stopName,
				figure,
				range,
			)} ${context.url}`,
		};
	}
	if (located.state === 'unmeasured') {
		return {
			...base,
			period: period(located.row, locale),
			status: t[UNMEASURED[located.row.state as keyof typeof UNMEASURED]],
		};
	}
	return { ...base, period: null, status: t[STATUS[located.state]] as string };
}
