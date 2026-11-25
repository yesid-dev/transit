import { intl, type Locale } from '#lib/i18n/copy.ts';
import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
import { serviceClockParts } from '#lib/utils/serviceDate.ts';
import {
	clockFace,
	formatClock,
	formatRelativeSeconds,
	formatDateKey,
	formatUtc,
	providerLocalDateKey,
} from '#lib/utils/time.ts';
import { presenterCopy } from './presenter.copy.ts';
import { formatTransitName } from './transitDisplay.ts';
import type { NameSeparators } from '#lib/v1/schemas/providers.ts';
import { stampCopy, type LiveState } from '#lib/v1/stamp.copy.ts';

export function minuteReading(
	minutes: number | null | undefined,
	locale: Locale,
	signed = false,
): string | null {
	if (minutes == null || !Number.isFinite(minutes)) return null;
	const number = intl
		.number(locale, {
			maximumFractionDigits: 1,
			signDisplay: signed ? 'exceptZero' : 'auto',
		})
		.format(minutes === 0 ? 0 : minutes);
	return presenterCopy[locale].minutes(number.replace(/^-/, '−'));
}

export function delayReading(
	seconds: number | null | undefined,
	locale: Locale,
	fallback = transitTerms[locale].delayUnknown,
): string {
	if (seconds == null || !Number.isFinite(seconds)) return fallback;
	const copy = presenterCopy[locale];
	const magnitude = minuteReading(Math.abs(seconds) / 60, locale)!;
	return seconds < 0 ? copy.early(magnitude) : seconds > 0 ? copy.late(magnitude) : copy.onSchedule;
}

/** Inclusive delay bounds, shown exactly to the second as signed minutes:seconds. */
export function delayRange(min: number | null, max: number | null, locale: Locale): string {
	const copy = presenterCopy[locale];
	if (min === null && max !== null)
		return copy.earlierThan(minuteReading(-(max + 1) / 60, locale)!);
	if (max === null && min !== null) return copy.atLeastLate(minuteReading(min / 60, locale)!);
	const minuteClock = (seconds: number) => {
		const sign = seconds < 0 ? '−' : seconds > 0 ? '+' : '';
		const magnitude = Math.abs(seconds);
		return `${sign}${Math.floor(magnitude / 60)}:${String(magnitude % 60).padStart(2, '0')}`;
	};
	return min === null || max === null ? '' : copy.delayRange(minuteClock(min), minuteClock(max));
}

export function clockTime(date: Date, locale: Locale, timeZone = 'UTC'): string {
	return formatClock(date, locale, timeZone);
}

export function dateAndClock(iso: string, locale: Locale, timeZone = 'UTC', zoneName = false) {
	const date = new Date(iso);
	if (!Number.isFinite(+date)) return presenterCopy[locale].unknownTime;
	const day = formatUtc(iso, locale, { dateStyle: 'medium', timeZone });
	const clock = clockTime(date, locale, timeZone);
	const zone = zoneName
		? intl
				.dateTime(locale, { timeZone, timeZoneName: 'short' })
				.formatToParts(date)
				.find((part) => part.type === 'timeZoneName')?.value
		: null;
	return [`${day}, ${clock}`, zone].filter(Boolean).join(' ');
}

export function clockRange(start: string, end: string, locale: Locale, timeZone = 'UTC') {
	const from = dateAndClock(start, locale, timeZone);
	const day = providerLocalDateKey(start, timeZone);
	const to =
		day && day === providerLocalDateKey(end, timeZone)
			? clockTime(new Date(end), locale, timeZone)
			: dateAndClock(end, locale, timeZone);
	return [from, to].join('–');
}

export function serviceTime(value: unknown, locale: Locale): string | null {
	const parts = serviceClockParts(value);
	if (!parts) return null;
	const { hours, minutes } = parts;
	const day = Math.floor(hours / 24);
	const clock = clockFace(hours % 24, minutes);
	const copy = presenterCopy[locale];
	return day === 0 ? clock : day === 1 ? copy.nextDay(clock) : copy.laterDay(clock, day);
}

export function scheduledClock(value: unknown, locale: Locale): string {
	return serviceTime(value, locale) ?? presenterCopy[locale].unknownTime;
}

export function scheduleHours(start: number, end: number, locale: Locale) {
	const from = clockFace(start, 0);
	const to = clockFace(end, 0);
	return locale === 'fr' ? `${from} à ${to}` : `${from} to ${to}`;
}

export function plannedInterval(tripsPerHour: number, locale: Locale) {
	const interval = minuteReading(60 / tripsPerHour, locale);
	if (!interval) return locale === 'fr' ? 'Inconnu' : 'Unknown';
	return locale === 'fr' ? `toutes les ${interval}` : `every ${interval}`;
}

export function dailyScheduledTrips(trips: number, locale: Locale) {
	return intl.number(locale, { maximumFractionDigits: 1 }).format(trips);
}

export function directionName(
	headsign: string | null | undefined,
	locale: Locale,
	rule?: NameSeparators,
): string {
	return headsign?.trim()
		? formatTransitName(headsign.trim(), locale, rule)
		: presenterCopy[locale].unknownDirection;
}

export function lineSubtitle(
	type: number | null,
	headsigns: Record<number, string>,
	locale: Locale,
	rule?: NameSeparators,
) {
	const modes: Record<number, [string, string]> = {
		0: ['Light rail', 'Tramway'],
		1: ['Métro', 'Métro'],
		2: ['Rail', 'Train'],
		3: ['Road transit', 'Transport routier'],
		4: ['Ferry', 'Traversier'],
	};
	const mode = type == null ? undefined : modes[type]?.[locale === 'fr' ? 1 : 0];
	const ends = [
		...new Set(
			[headsigns[1], headsigns[0]]
				.filter(Boolean)
				.map((name) => formatTransitName(name, locale, rule)),
		),
	];
	const route = ends.join(locale === 'fr' ? ' à ' : ' to ');
	return [mode, route].filter(Boolean).join(' · ') || undefined;
}

export function lineRecordHeading(
	line: { number: string | null; name: string | null; label: string },
	locale: Locale,
) {
	const { number, name, label } = line;
	if (!name || !number || !/^\d+$/u.test(number) || name === number) return name ?? label;
	const prefix = locale === 'fr' ? 'Ligne' : 'Line';
	return `${prefix} ${number} ${name}`;
}

export function directionLabel(
	direction: string | number | null | undefined,
	headsigns: Readonly<Record<number, string>>,
	locale: Locale,
	rule?: NameSeparators,
): string {
	const name = direction == null || direction === '' ? null : headsigns[Number(direction)];
	const copy = presenterCopy[locale];
	return name?.trim() ? copy.toward(directionName(name, locale, rule)) : copy.unknownDirection;
}

export function longDate(date: string, locale: Locale): string {
	return formatDateKey(date, locale, true, 'day-first', 'long');
}

export function compactServiceDay(date: string, locale: Locale): string {
	return formatDateKey(date, locale, false, 'day-first');
}

export function dateRange({ from, to }: { from: string; to: string }, locale: Locale): string {
	const end = formatDateKey(to, locale, true, 'day-first');
	if (from === to) return end;
	const sameYear = from.slice(0, 4) === to.slice(0, 4);
	const sameMonth = from.slice(0, 7) === to.slice(0, 7);
	const start = sameMonth
		? String(Number(from.slice(8, 10)))
		: formatDateKey(from, locale, !sameYear, 'day-first');
	return presenterCopy[locale].dateRange(start, end);
}

export function fileSize(bytes: number | null | undefined, locale: Locale): string | null {
	if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
	return intl
		.number(locale, {
			style: 'unit',
			unit: 'megabyte',
			unitDisplay: 'short',
			maximumSignificantDigits: 3,
		})
		.format(bytes / 1_000_000);
}

export function versionNumber(value: string | number | null | undefined): string | null {
	if (value == null) return null;
	const raw = String(value).trim();
	const number = /(?:^v?|[-_]v)(\d+(?:\.\d+)*)$/i.exec(raw)?.[1];
	return number ? `v${number}` : raw || null;
}

export function methodEvidence(
	{
		method_version,
		cleaning_versions,
	}: { method_version: string; cleaning_versions: readonly number[] },
	locale: Locale,
	compact = false,
): string {
	const copy = presenterCopy[locale];
	const method = copy.method(versionNumber(method_version) ?? copy.unknownVersion);
	const cleaning = copy.cleaning(
		cleaning_versions.map(versionNumber).join(', ') || copy.unknownVersion,
	);
	const text = `${method}, ${cleaning}`;
	return compact ? text[0].toLocaleLowerCase(locale) + text.slice(1) : `${text}.`;
}

export function lineName(
	number: string | null | undefined,
	name: string | null | undefined,
	fallback: () => string,
	spoken: (label: string) => string,
) {
	number = number?.trim() || null;
	name = name?.trim() || null;
	const label = number && name && number !== name ? `${number} · ${name}` : (number ?? name);
	if (label) return { number, name, label, spoken: spoken(label) };
	const missing = fallback();
	return { number, name, label: missing, spoken: missing };
}

export function tripsInHours(trips: number, hours: number, locale: Locale): string {
	const format = intl.number(locale);
	return presenterCopy[locale].tripsInHours(
		format.format(trips),
		format.format(hours),
		trips === 1,
		hours === 1,
	);
}

/** Registry descriptions can document raw sub-minute inputs and export columns. */
export function registryUnitText(text: string, locale: Locale) {
	return presenterCopy[locale].registryUnitText(text);
}

export function recordStamp(period: { from: string; to: string }, locale: Locale) {
	return `${locale === 'fr' ? 'Bilan' : 'Record'} · ${dateRange(period, locale)}`;
}

export function countedUnit(
	value: number,
	unit: 'line' | 'stop' | 'event' | 'trip' | 'day' | 'vehicle',
	locale: Locale,
) {
	const labels = {
		line: { en: ['line', 'lines'], fr: ['ligne', 'lignes'] },
		stop: { en: ['stop', 'stops'], fr: ['arrêt', 'arrêts'] },
		event: { en: ['stop event', 'stop events'], fr: ['passage à un arrêt', 'passages aux arrêts'] },
		trip: { en: ['trip', 'trips'], fr: ['trajet', 'trajets'] },
		day: { en: ['day', 'days'], fr: ['jour', 'jours'] },
		vehicle: { en: ['vehicle', 'vehicles'], fr: ['véhicule', 'véhicules'] },
	};
	const plural = !singularCount(value, locale);
	return `${intl.number(locale).format(value)} ${labels[unit][locale][Number(plural)]}`;
}

export function recordRatio(count: number, total: string, locale: Locale) {
	return `${intl.number(locale).format(count)} ${recordDenominator(total, locale)}`;
}

export function recordDenominator(total: string, locale: Locale) {
	return `${locale === 'fr' ? 'sur' : 'of'} ${total}`;
}

export function singularCount(value: number, locale: Locale) {
	return locale === 'fr' ? value < 2 : value === 1;
}

export function liveStampAge(seconds: number | null, locale: Locale, state: LiveState = 'current') {
	if (seconds == null && state === 'behind') {
		const unknown = stampCopy[locale].live('data', 'unknown', null);
		return `${unknown} · ${locale === 'fr' ? 'pas à jour' : 'not current'}`;
	}
	return stampCopy[locale].live(
		'data',
		state,
		seconds == null ? null : formatRelativeSeconds(seconds, locale),
	);
}

export function sampleWithMinimum(sample: string, minimum: number, locale: Locale) {
	const number = intl.number(locale).format(minimum);
	return `${sample} (${locale === 'fr' ? 'minimum de' : 'minimum'} ${number})`;
}

export function hoursReading(hours: number, locale: Locale) {
	return `${intl.number(locale, { maximumFractionDigits: 1 }).format(hours)}\u00a0h`;
}

export function relativeReportAge(seconds: number, locale: Locale) {
	return formatRelativeSeconds(Math.max(0, Math.floor(seconds)), locale);
}

export function serviceWeekday(day: string, locale: Locale) {
	return intl
		.dateTime(locale, { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
		.format(new Date(day));
}

export function vehiclePositionsCapture(seconds: number | null | undefined, locale: Locale) {
	const age =
		seconds == null
			? locale === 'fr'
				? 'indisponibles'
				: 'unavailable'
			: seconds < 1
				? locale === 'fr'
					? 'à l’instant'
					: 'now'
				: relativeReportAge(seconds, locale);
	return locale === 'fr' ? `Positions des véhicules : ${age}.` : `Vehicle positions: ${age}.`;
}
