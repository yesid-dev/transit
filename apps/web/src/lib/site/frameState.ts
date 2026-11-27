import { providerLocalDateKey } from '#lib/utils/serviceDate.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

export const RECORD_START = '2026-10-13';
export const MAX_RECORD_DAYS = 400;
export const PRESETS = [
	'yesterday',
	'7-days',
	'28-days',
	'this-month',
	'last-month',
	'12-months',
] as const;
export type Preset = (typeof PRESETS)[number];
export type FrameMode = 'live' | 'record';
export type PeriodError = 'invalidDate' | 'reversed' | 'beforeRecord' | 'future' | 'tooLong';

interface FramePeriod extends DateWindow {
	preset: Preset | null;
}

interface FrameState {
	mode: FrameMode;
	period: FramePeriod | null;
}

const KEYS = ['frameMode', 'period', 'recordFrom', 'recordTo'] as const;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const chosenPreset = (params: URLSearchParams) =>
	PRESETS.find((option) => option === params.get('period'));

type FrameProvider =
	| Pick<PublicCity, 'timezone' | 'record_through' | 'record_from'>
	| null
	| undefined;

export interface FrameClock {
	today: string;
	recordThrough: string | null;
	/** First day of this city's record; RECORD_START when it declares none. */
	recordStart?: string;
}

/** A city's record starts on its declared first day, never before the site's record. */
export function recordStart(provider?: Pick<PublicCity, 'record_from'> | null): string {
	const declared = provider?.record_from;
	return declared && isDay(declared) && declared > RECORD_START ? declared : RECORD_START;
}

export function frameClock(provider: FrameProvider, now = new Date()): FrameClock {
	return {
		today: providerLocalDateKey(now.toISOString(), provider?.timezone)!,
		recordThrough: provider?.record_through ?? null,
		recordStart: recordStart(provider),
	};
}

/**
 * The clock's time after a new look at the screen: `next` only when the city's local day has
 * changed. Within the same day the frame stays as it is, so a focus never rebuilds it.
 */
export function clockOnFocus(provider: FrameProvider, current: Date, next = new Date()): Date {
	return frameClock(provider, next).today === frameClock(provider, current).today ? current : next;
}

const shiftDay = (day: string, offset: number) =>
	isoDay(new Date(Date.parse(day) + offset * 86_400_000));
const minDay = (a: string, b: string) => (a < b ? a : b);

function lastBuiltDay({ today, recordThrough }: FrameClock) {
	return recordThrough && isDay(recordThrough) ? minDay(recordThrough, shiftDay(today, -1)) : null;
}

export function frameDateLimit({ today, recordThrough }: FrameClock) {
	return recordThrough ? shiftDay(today, -1) : today;
}

function isDay(key: string): boolean {
	const date = new Date(key + 'T00:00:00Z');
	return Number.isFinite(date.getTime()) && isoDay(date) === key;
}

export function periodError(
	{ from, to }: DateWindow,
	today: string,
	start: string = RECORD_START,
): PeriodError | null {
	if (!isDay(from) || !isDay(to)) return 'invalidDate';
	if (from > to) return 'reversed';
	if (from < start) return 'beforeRecord';
	if (to > today) return 'future';
	if (Date.parse(to) - Date.parse(from) >= MAX_RECORD_DAYS * 86_400_000) return 'tooLong';
	return null;
}

export function presetPeriod(preset: Preset, clock: FrameClock): FramePeriod | null {
	const { today, recordStart: start = RECORD_START } = clock;
	const date = new Date(today + 'T00:00:00Z');
	const yesterday = shiftDay(today, -1);
	const through = lastBuiltDay(clock);
	const end = through ?? yesterday;
	const yearEnd = through ? new Date(shiftDay(through, 1) + 'T00:00:00Z') : date;
	const monthStart = (offset: number) =>
		isoDay(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)));
	const lastDayOfPreviousMonth = isoDay(
		new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0)),
	);
	const year = yearEnd.getUTCFullYear() - 1;
	const month = yearEnd.getUTCMonth();
	const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const lastYear = isoDay(
		new Date(Date.UTC(year, month, Math.min(yearEnd.getUTCDate(), daysInMonth))),
	);
	const periods = {
		yesterday: { from: yesterday, to: yesterday },
		'7-days': { from: shiftDay(end, -6), to: end },
		'28-days': { from: shiftDay(end, -27), to: end },
		'this-month': { from: monthStart(0), to: through ?? today },
		'last-month': {
			from: monthStart(-1),
			to: through ? minDay(lastDayOfPreviousMonth, through) : lastDayOfPreviousMonth,
		},
		'12-months': { from: lastYear, to: end },
	};
	const period = { ...periods[preset], preset };
	// Calendar presets start at the city's first day; a rolling one must fit inside its record.
	if (
		(preset === 'this-month' || preset === 'last-month' || preset === '12-months') &&
		period.from < start
	)
		period.from = start;
	return periodError(period, today, start) ? null : period;
}

export function parseFrameState(params: URLSearchParams, clock: FrameClock): FrameState {
	const mode = params.get('frameMode') === 'live' ? 'live' : 'record';
	const requested = chosenPreset(params);
	const from = params.get('recordFrom') ?? '';
	const to = params.get('recordTo') ?? '';
	const preset =
		requested ??
		PRESETS.find((option) => {
			const choice = presetPeriod(option, clock);
			return choice?.from === from && choice.to === to;
		});
	const period = { preset: preset ?? null, from, to };
	if (
		!periodError(period, frameDateLimit(clock), clock.recordStart) &&
		(!unpublishedRecordDates(params, clock) || unpublishedYesterday(period, clock))
	)
		return { mode, period };
	return {
		mode,
		period:
			(!from && !to && requested ? presetPeriod(requested, clock) : null) ??
			presetPeriod('7-days', clock) ??
			presetPeriod(clock.recordThrough ? '12-months' : 'yesterday', clock),
	};
}

export function unpublishedRecordDates(
	params: URLSearchParams,
	clock: FrameClock,
): DateWindow | null {
	const through = lastBuiltDay(clock);
	const period = { from: params.get('recordFrom') ?? '', to: params.get('recordTo') ?? '' };
	return through && period.from > through && !periodError(period, '9999-12-31', clock.recordStart)
		? period
		: null;
}

function unpublishedYesterday(period: FrameState['period'], { recordThrough }: FrameClock) {
	return recordThrough &&
		period?.preset === 'yesterday' &&
		period.from === period.to &&
		period.to > recordThrough
		? period.to
		: null;
}

/** Record readings keep Yesterday selected while showing the latest available day. */
export function recordAnswerPeriod(period: FrameState['period'], clock: FrameClock) {
	const through = lastBuiltDay(clock);
	return period && through && unpublishedYesterday(period, clock)
		? { ...period, from: through, to: through }
		: period;
}

/**
 * The menu's Daily report opens one day, never a week: the day already in view, or else
 * Yesterday. Until Yesterday is built, the report answers with the last built day and says so.
 */
export function dailyReportPeriod(
	period: FrameState['period'],
	clock: FrameClock,
): FramePeriod | null {
	if (period && period.from === period.to) return period;
	const yesterday = presetPeriod('yesterday', clock);
	if (yesterday) return yesterday;
	const through = lastBuiltDay(clock);
	return through ? { from: through, to: through, preset: null } : null;
}

export function receiptFrameParams(params: URLSearchParams, clock: FrameClock) {
	const date = params.get('date');
	if (!date || params.has('recordFrom')) return params;
	const legacy = new URLSearchParams({ recordFrom: date, recordTo: date });
	return unpublishedRecordDates(legacy, clock) ? legacy : params;
}

export function parseAnswerFrameState(params: URLSearchParams, clock: FrameClock): FrameState {
	const frame = parseFrameState(params, clock);
	return { ...frame, period: recordAnswerPeriod(frame.period, clock) };
}

/** Keep the frame separate from the date, mode and range filters on existing pages. */
export function carryFrameState(href: string, source: URL): string {
	const target = new URL(href, source);
	for (const key of KEYS) {
		const value = source.searchParams.get(key);
		if (value !== null) target.searchParams.set(key, value);
	}
	return target.pathname + target.search + target.hash;
}

export function frameHref(url: URL, { mode, period }: FrameState): string {
	const target = new URL(url);
	const sameDates =
		period?.from === target.searchParams.get('recordFrom') &&
		period?.to === target.searchParams.get('recordTo');
	const preset = period?.preset ?? (sameDates ? chosenPreset(target.searchParams) : undefined);
	target.searchParams.set('frameMode', mode);
	for (const key of KEYS.slice(1)) target.searchParams.delete(key);
	if (period) {
		if (preset) target.searchParams.set('period', preset);
		target.searchParams.set('recordFrom', period.from);
		target.searchParams.set('recordTo', period.to);
	}
	return target.pathname + target.search + target.hash;
}
