import { providerLocalDateKey } from '#lib/utils/serviceDate.ts';
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

export function frameToday(timeZone: string | undefined, now = new Date()): string {
	return providerLocalDateKey(now.toISOString(), timeZone)!;
}

function isDay(key: string): boolean {
	const date = new Date(key + 'T00:00:00Z');
	return Number.isFinite(date.getTime()) && isoDay(date) === key;
}

export function periodError({ from, to }: DateWindow, today: string): PeriodError | null {
	if (!isDay(from) || !isDay(to)) return 'invalidDate';
	if (from > to) return 'reversed';
	if (from < RECORD_START) return 'beforeRecord';
	if (to > today) return 'future';
	if (Date.parse(to) - Date.parse(from) >= MAX_RECORD_DAYS * 86_400_000) return 'tooLong';
	return null;
}

export function presetPeriod(preset: Preset, today: string): FramePeriod | null {
	const date = new Date(today + 'T00:00:00Z');
	const daysAgo = (days: number) =>
		isoDay(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - days)));
	const monthStart = (offset: number) =>
		isoDay(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)));
	const lastDayOfPreviousMonth = isoDay(
		new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0)),
	);
	const year = date.getUTCFullYear() - 1;
	const month = date.getUTCMonth();
	const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const lastYear = isoDay(
		new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), daysInMonth))),
	);
	const periods = {
		yesterday: { from: daysAgo(1), to: daysAgo(1) },
		'7-days': { from: daysAgo(7), to: daysAgo(1) },
		'28-days': { from: daysAgo(28), to: daysAgo(1) },
		'this-month': { from: monthStart(0), to: today },
		'last-month': { from: monthStart(-1), to: lastDayOfPreviousMonth },
		'12-months': { from: lastYear, to: daysAgo(1) },
	};
	const period = { ...periods[preset], preset };
	if (
		(preset === 'this-month' || preset === 'last-month' || preset === '12-months') &&
		period.from < RECORD_START
	)
		period.from = RECORD_START;
	return periodError(period, today) ? null : period;
}

export function parseFrameState(params: URLSearchParams, today: string): FrameState {
	const mode = params.get('frameMode') === 'live' ? 'live' : 'record';
	const preset = PRESETS.find((option) => option === params.get('period')) ?? null;
	const from = params.get('recordFrom') ?? '';
	const to = params.get('recordTo') ?? '';
	const period = { preset, from, to };
	if (!periodError(period, today)) return { mode, period };
	return { mode, period: presetPeriod('7-days', today) ?? presetPeriod('yesterday', today) };
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
	target.searchParams.set('frameMode', mode);
	for (const key of KEYS.slice(1)) target.searchParams.delete(key);
	if (period) {
		if (period.preset) target.searchParams.set('period', period.preset);
		target.searchParams.set('recordFrom', period.from);
		target.searchParams.set('recordTo', period.to);
	}
	return target.pathname + target.search + target.hash;
}
