// Node consumers use these formatters without a Svelte locale context.
import { intl } from '#lib/i18n/copy.ts';
export type TimeLang = 'en' | 'fr';

export { providerLocalDateKey } from './serviceDate.ts';

function parseIso(iso: string): Date | null {
	if (!iso) return null;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d;
}

export function elapsedUtcMinutes(
	first: string | null | undefined,
	last: string | null | undefined,
): number | null {
	const offset = /(?:z|[+-]\d{2}:\d{2})$/i;
	if (first == null || last == null || !offset.test(first) || !offset.test(last)) return null;
	const minutes = (Date.parse(last) - Date.parse(first)) / 60_000;
	return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

export function formatUtc(iso: string, lang: TimeLang, opts?: Intl.DateTimeFormatOptions): string {
	const date = parseIso(iso);
	if (!date) return '·';
	const base: Intl.DateTimeFormatOptions = {
		dateStyle: 'medium',
		timeStyle: 'short',
	};
	const resolved: Intl.DateTimeFormatOptions = {
		...(opts ?? base),
		timeZone: opts?.timeZone ?? 'UTC',
	};
	return intl.dateTime(lang, resolved).format(date);
}

export function formatDateKey(
	key: string,
	lang: TimeLang,
	includeYear = false,
	order?: 'day-first',
): string {
	const date = parseIso(key);
	if (!date) return '·';
	const formatter = intl.dateTime(lang, {
		month: 'short',
		day: 'numeric',
		...(includeYear ? { year: 'numeric' as const } : {}),
		timeZone: 'UTC',
	});
	if (order !== 'day-first') return formatter.format(date);
	const parts = formatter.formatToParts(date);
	return ['day', 'month', 'year']
		.map((type) => parts.find((part) => part.type === type)?.value)
		.filter(Boolean)
		.join(' ');
}

export function clockFace(hour: number, minute: number): string {
	return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function formatClock(date: Date, lang: TimeLang, timeZone: string = 'UTC'): string {
	if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '·';
	const parts = intl
		.dateTime(lang, {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			timeZone,
		})
		.formatToParts(date);
	const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
	const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
	return clockFace(Number(hour) % 24, Number(minute));
}

/**
 * A clock time for readers: the locale's own form (`7:21 p.m.`, `19 h 21`) in the network's zone,
 * or the host's zone when none is given. Not for parsing; `formatClock` stays the `HH:mm` form.
 */
export function formatLocalClock(date: Date, locale: TimeLang, timeZone?: string): string {
	if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '·';
	return intl.dateTime(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(date);
}

export function minutesSinceMidnight(date: Date, timeZone: string): number {
	if (!(date instanceof Date) || Number.isNaN(date.getTime())) return Number.NaN;
	const parts = intl
		.dateTime('en', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			timeZone,
		})
		.formatToParts(date);
	const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '00';
	const minuteRaw = parts.find((p) => p.type === 'minute')?.value ?? '00';
	const hour = hourRaw === '24' ? 0 : Number.parseInt(hourRaw, 10);
	const minute = Number.parseInt(minuteRaw, 10);
	if (Number.isNaN(hour) || Number.isNaN(minute)) return Number.NaN;
	return hour * 60 + minute;
}

export function ageSeconds(iso: string, now: Date | number = Date.now()): number {
	const date = parseIso(iso);
	if (!date) return Number.NaN;
	const nowMs = typeof now === 'number' ? now : now.getTime();
	return Math.round((nowMs - date.getTime()) / 1000);
}

export function formatRelativeSeconds(seconds: number, lang: TimeLang): string {
	return Number.isNaN(seconds)
		? '·'
		: intl.relativeTime(lang, -seconds).replace(/\b(?:seconds?|secondes?)\b/u, 's');
}

export function formatRelative(iso: string, lang: TimeLang, now: Date = new Date()): string {
	return formatRelativeSeconds(ageSeconds(iso, now), lang);
}
