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
import { compassPoint, type LinePattern } from './linePatterns';
import { livePause } from '#lib/live/livePause.ts';
import type { StampProps } from '@yesid/ui/brand';

export function searchCount(value: number, locale: Locale): string {
	return intl.number(locale).format(value);
}

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
	const minutes = Math.abs(seconds) / 60;
	// The display rounds to a tenth of a minute.
	if (minutes < 0.05) return copy.onSchedule;
	const magnitude = minuteReading(minutes, locale)!;
	return seconds < 0 ? copy.early(magnitude) : copy.late(magnitude);
}

/**
 * The words of a live status mark. A late or early vehicle reads as its delay alone ("14 min
 * late"); an on-time vehicle keeps "On time" and gives a small gap in brackets ("On time (4 min
 * behind)"), and nothing when it is on schedule.
 */
export function liveStatusWords(
	status: 'early' | 'on_time' | 'late' | 'unknown',
	label: string,
	delaySeconds: number | null | undefined,
	locale: Locale,
): { label: string; detail?: string } {
	if (status === 'unknown' || delaySeconds == null || !Number.isFinite(delaySeconds))
		return { label };
	const minutes = Math.abs(delaySeconds) / 60;
	// The display rounds to a tenth of a minute.
	if (minutes < 0.05) return { label };
	const copy = presenterCopy[locale];
	const magnitude = minuteReading(minutes, locale)!;
	if (status === 'on_time')
		return { label, detail: delaySeconds < 0 ? copy.ahead(magnitude) : copy.behind(magnitude) };
	return { label: status === 'early' ? copy.early(magnitude) : copy.late(magnitude) };
}

export function distanceReading(distanceM: number, locale: Locale): string {
	const separator = locale === 'fr' ? '\u00a0' : ' ';
	if (distanceM < 1_000) return `${intl.number(locale).format(Math.round(distanceM))}${separator}m`;
	return `${intl.number(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(distanceM / 1_000)}${separator}km`;
}

export function mapRecordReading(value: number, stops: boolean, locale: Locale): string | null {
	if (stops)
		return intl
			.number(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
			.format(value / 1000);
	return `${intl.number(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 60)} min`;
}

export function mapDirectionReading(name: string, locale: Locale): string {
	return towardReading(name, locale, undefined, false);
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

/**
 * A clock time as the reader writes it: "04:48" in English, "4 h 48" and "7 h" in Québec French.
 * Every clock a page shows comes through here.
 */
export function readerClock(hour: number, minute: number, locale: Locale): string {
	if (locale !== 'fr') return clockFace(hour, minute);
	const hours = `${hour}\u00a0h`;
	return minute === 0 ? hours : `${hours}\u00a0${String(minute).padStart(2, '0')}`;
}

export function clockTime(date: Date, locale: Locale, timeZone = 'UTC'): string {
	const face = formatClock(date, locale, timeZone);
	const parts = /^(\d{2}):(\d{2})$/u.exec(face);
	return parts ? readerClock(Number(parts[1]), Number(parts[2]), locale) : face;
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

export function noticeCount(count: number, locale: Locale) {
	const label = locale === 'fr' ? 'avis' : count === 1 ? 'notice' : 'notices';
	return `${intl.number(locale).format(count)} ${label}`;
}

function publishedAlertUnit(count: number, locale: Locale) {
	return locale === 'fr'
		? count === 1
			? 'avis tel que publié'
			: 'avis tels que publiés'
		: count === 1
			? 'alert as published'
			: 'alerts as published';
}

export function publishedAlertCount(count: number, locale: Locale) {
	return `${intl.number(locale).format(count)} ${publishedAlertUnit(count, locale)}`;
}

export function noticeCountEvidence(
	grouped: number,
	published: number,
	agency: AgencyName,
	locale: Locale,
) {
	if (grouped === published) return `${noticeCount(grouped, locale)}.`;
	const total = intl.number(locale).format(published);
	return locale === 'fr'
		? `${noticeCount(grouped, locale)}, issu${grouped === 1 ? '' : 's'} de ${total} avis publié${published === 1 ? '' : 's'} par ${frenchAgency(agency).subject}, un par ligne et par mise à jour.`
		: `${noticeCount(grouped, locale)}, from ${total} ${published === 1 ? 'alert' : 'alerts'} as ${agency.name} published ${published === 1 ? 'it' : 'them'}, one per line and reissue.`;
}

export function alertAnswerSentence(
	count: number,
	locale: Locale,
	live: boolean,
	published = false,
) {
	if (published) return publishedAlertUnit(count, locale) + '.';
	if (locale === 'fr') {
		if (live) return count < 2 ? `avis est en vigueur.` : `avis sont en vigueur.`;
		return count < 2
			? 'avis était en vigueur à un moment donné à ces dates.'
			: 'avis étaient en vigueur à un moment donné à ces dates.';
	}
	if (live) return count === 1 ? 'notice is in effect now.' : 'notices are in effect now.';
	return count === 1
		? 'notice was in effect at some point in these dates.'
		: 'notices were in effect at some point in these dates.';
}

export function dailyAlertsLink(count: number, locale: Locale, published = false) {
	const unit = published ? publishedAlertCount(count, locale) : noticeCount(count, locale);
	return locale === 'fr'
		? `Voir ${unit} dans les avis de service`
		: `See ${unit} in Service alerts`;
}

export function alertPaging(locale: Locale, notices = false) {
	const { format } = intl.number(locale);
	return {
		showing: (shown: number, total: number) =>
			locale === 'fr'
				? `${format(shown)} sur ${notices ? noticeCount(total, locale) : format(total)}`
				: `Showing ${format(shown)} of ${notices ? noticeCount(total, locale) : format(total)}`,
		more: (count: number) =>
			locale === 'fr' ? `Afficher ${format(count)} de plus` : `Show ${format(count)} more`,
	};
}

export function serviceTime(value: unknown, locale: Locale): string | null {
	const parts = serviceClockParts(value);
	if (!parts) return null;
	const { hours, minutes } = parts;
	const day = Math.floor(hours / 24);
	const clock = readerClock(hours % 24, minutes, locale);
	const copy = presenterCopy[locale];
	return day === 0 ? clock : day === 1 ? copy.nextDay(clock) : copy.laterDay(clock, day);
}

export function scheduledClock(value: unknown, locale: Locale): string {
	return serviceTime(value, locale) ?? presenterCopy[locale].unknownTime;
}

export function scheduleHours(start: number, end: number, locale: Locale) {
	const from = readerClock(start, 0, locale);
	const to = readerClock(end, 0, locale);
	return locale === 'fr' ? `${from} à ${to}` : `${from} to ${to}`;
}

export function plannedInterval(tripsPerHour: number, locale: Locale) {
	const minutes = Math.max(1, Math.round(60 / tripsPerHour));
	const interval = minuteReading(minutes, locale);
	if (!interval) return locale === 'fr' ? 'Inconnu' : 'Unknown';
	if (minutes === 1) return locale === 'fr' ? 'chaque minute' : 'every minute';
	return locale === 'fr' ? `toutes les ${interval}` : `every ${interval}`;
}

export function dailyScheduledTrips(trips: number, locale: Locale) {
	return intl.number(locale, { maximumFractionDigits: 1 }).format(trips);
}

/**
 * A terminus as riders name it: the agency's cross street in brackets is dropped ("Station
 * Laurier (Saint-Joseph / Berri)" reads "Station Laurier"). A compass word in brackets stays.
 */
export function terminusName(name: string): string {
	const bracketed = /^(.*\S)\s*\(([^()]*)\)$/u.exec(name.trim());
	return bracketed && !compassPoint.test(bracketed[2].trim()) ? bracketed[1] : name.trim();
}

/**
 * A terminus written as a place a rider goes. A name that starts with a lowercase particle ("du
 * Square-Victoria / Saint-Antoine") is a cross street, so it reads as "l’arrêt du …" and "the
 * stop du …", never "Vers du …".
 */
function terminusPlace(name: string, locale: Locale, rule?: NameSeparators) {
	const shown = formatTransitName(terminusName(name), locale, rule);
	if (!/^(?:du|de|des|d['’])(?=[\s\p{L}])/u.test(shown)) return shown;
	return `${locale === 'fr' ? 'l’arrêt' : 'the stop'} ${shown}`;
}

export function riderHeadsign(headsign: string | null | undefined, pattern?: LinePattern) {
	const sign = headsign?.trim();
	const terminus = sign && compassPoint.test(sign) && pattern?.termini[sign.toLowerCase()];
	return terminus ? `${terminusName(terminus)} (${sign})` : sign;
}

export function directionName(
	headsign: string | null | undefined,
	locale: Locale,
	rule?: NameSeparators,
): string {
	const name = headsign?.trim();
	if (!name) return presenterCopy[locale].unknownDirection;
	const terminus = /^(.*) \(([^()]*)\)$/u.exec(name);
	if (terminus && compassPoint.test(terminus[2])) {
		const compass = locale === 'fr' ? terminus[2].toLowerCase() : terminus[2];
		return `${terminusPlace(terminus[1], locale, rule)} (${compass})`;
	}
	if (compassPoint.test(name)) {
		const words: Record<string, [string, string]> = {
			est: ['the east', 'l’est'],
			ouest: ['the west', 'l’ouest'],
			nord: ['the north', 'le nord'],
			sud: ['the south', 'le sud'],
		};
		const key =
			{ east: 'est', west: 'ouest', north: 'nord', south: 'sud' }[name.toLowerCase()] ??
			name.toLowerCase();
		return words[key][locale === 'fr' ? 1 : 0];
	}
	return terminusPlace(name, locale, rule);
}

export function towardReading(name: string, locale: Locale, rule?: NameSeparators, capital = true) {
	const label = presenterCopy[locale].toward(directionName(name, locale, rule));
	return capital ? label : label[0].toLowerCase() + label.slice(1);
}

export function lineSubtitle(
	type: number | null,
	ends: readonly string[] | undefined,
	locale: Locale,
	rule?: NameSeparators,
) {
	const modes: Record<number, [string, string]> = {
		0: ['Tram', 'Train léger'],
		1: ['Métro', 'Métro'],
		2: ['Train', 'Train'],
		4: ['Ferry', 'Traversier'],
	};
	const mode = type == null ? undefined : modes[type]?.[locale === 'fr' ? 1 : 0];
	const stops = [...new Set((ends ?? []).map((name) => terminusPlace(name, locale, rule)))];
	return [mode, routeBetween(stops, locale, mode != null)].filter(Boolean).join(' · ') || undefined;
}

/** "Gare Montréal-Ouest to Station Laurier"; in French "De Gare Montréal-Ouest à Station Laurier". */
function routeBetween(stops: string[], locale: Locale, afterMode: boolean) {
	if (locale !== 'fr') {
		const route = stops.join(' to ');
		return afterMode ? route : route.replace(/^the stop /u, 'The stop ');
	}
	if (stops.length !== 2) return stops.join(' à ');
	const [from, to] = stops;
	const de = afterMode ? 'de' : 'De';
	const start = /^[aeiouyhàâäéèêëîïôöùûüœ]/iu.test(from)
		? `${de.slice(0, 1)}’${from}`
		: `${de} ${from}`;
	return `${start} à ${to}`;
}

export function lineRecordHeading(
	line: { number: string | null; name: string | null; label: string },
	locale: Locale,
) {
	const { number, name, label } = line;
	if (!name || !number || !/^\d+$/u.test(number) || name === number) return name ?? label;
	const prefix = locale === 'fr' ? 'Ligne' : 'Line';
	const leading = /^(?:line|ligne)[\s\p{P}\p{S}]+(\d+)(?=$|[\s\p{P}\p{S}])/iu.exec(name);
	const remainder =
		leading?.[1] === number ? name.slice(leading[0].length).replace(/^[\s\p{P}\p{S}]+/u, '') : name;
	return [prefix, number, remainder].filter(Boolean).join(' ');
}

export function directionLabel(
	direction: string | number | null | undefined,
	headsigns: Readonly<Record<number, string>>,
	locale: Locale,
	rule?: NameSeparators,
): string {
	const name = direction == null || direction === '' ? null : headsigns[Number(direction)];
	const copy = presenterCopy[locale];
	return name?.trim() ? towardReading(name, locale, rule) : copy.unknownDirection;
}

export function stopTrendGap(minimum: number, allDays: boolean, locale: Locale) {
	const count = intl.number(locale).format(minimum);
	if (locale === 'fr')
		return allDays
			? `Trop peu de passages aux arrêts chaque jour pour tracer la courbe de cet arrêt (minimum de ${count} par jour).`
			: `Trop peu de passages aux arrêts certains jours pour tracer la courbe de cet arrêt (minimum de ${count} par jour).`;
	return allDays
		? `Too few stop events per day to draw this stop’s line (minimum ${count} per day).`
		: `Too few stop events per day to draw this stop’s line on some days (minimum ${count} per day).`;
}

export function longDate(date: string, locale: Locale): string {
	return formatDateKey(date, locale, true, 'day-first', 'long');
}

export function compactServiceDay(date: string, locale: Locale): string {
	return formatDateKey(date, locale, false, 'day-first');
}

export function shortServiceDay(date: string, locale: Locale) {
	const parts = intl
		.dateTime(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
		.formatToParts(new Date(date));
	return ['weekday', 'day', 'month']
		.map((key) => parts.find((part) => part.type === key)?.value)
		.join(' ');
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

export function dailyReportTitle({ from, to }: { from: string; to: string }, locale: Locale) {
	const fr = locale === 'fr';
	const end = longDate(to, locale);
	if (from === to) {
		const weekday = intl
			.dateTime(locale, { weekday: 'long', timeZone: 'UTC' })
			.format(new Date(to));
		return `${fr ? 'Rapport du' : 'Report for'} ${weekday} ${end}`;
	}
	const start =
		from.slice(0, 7) === to.slice(0, 7)
			? String(Number(from.slice(8)))
			: formatDateKey(from, locale, from.slice(0, 4) !== to.slice(0, 4), 'day-first', 'long');
	return fr ? `Rapport du ${start} au ${end}` : `Report for ${start} to ${end}`;
}

export function reportHours(start: number, end: number, locale: Locale) {
	return [readerClock(start, 0, locale), readerClock(end, 0, locale)].join(
		locale === 'fr' ? ' à ' : ' to ',
	);
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
	}: { method_version: string; cleaning_versions?: readonly number[] },
	locale: Locale,
	compact = false,
): string {
	const copy = presenterCopy[locale];
	const method = copy.method(versionNumber(method_version) ?? copy.unknownVersion);
	const text = cleaning_versions
		? `${method}, ${copy.cleaning(cleaning_versions.map(versionNumber).join(', ') || copy.unknownVersion)}`
		: method;
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

/** A route plate already prints the number supplied at the start of some line names. */
export function noticeLineName(number: string, name: string | null) {
	let detail = name?.trim();
	while (detail?.startsWith(number)) {
		const remaining = detail.slice(number.length).match(/^\s*[/·:-]\s*(.+)$/u)?.[1];
		if (!remaining) break;
		detail = remaining;
	}
	return detail && detail !== number ? detail : null;
}

export function noticeStopName(text: string, stop: string, locale: Locale) {
	return locale === 'fr'
		? text.replace(/^Cet arrêt\b/iu, `L’arrêt ${stop}`)
		: text.replace(/^This stop\b/iu, `Stop ${stop}`);
}

export const countedNotice = {
	en: 'Each notice counts once, however many times the agency reissued it.',
	fr: 'Chaque avis compte une fois, même si la société de transport l’a republié.',
};

export function noticesForLines(lines: readonly string[], locale: Locale) {
	const list = new Intl.ListFormat(locale).format(lines);
	if (locale === 'fr') return `Avis pour ${lines.length === 1 ? 'la ligne' : 'les lignes'} ${list}`;
	return `Notices for ${lines.length === 1 ? 'line' : 'lines'} ${list}`;
}

export function noLiveStopNotices(agency: AgencyName, locale: Locale) {
	if (locale === 'en') return `${agency.name} has no notice in effect for this stop.`;
	const subject = frenchAgency(agency).subject;
	return `${subject.charAt(0).toLocaleUpperCase('fr')}${subject.slice(1)} n’a aucun avis en vigueur pour cet arrêt.`;
}

export function noPublishedNotices(
	agency: AgencyName,
	scope: 'stop' | 'line' | 'network',
	locale: Locale,
	complete = true,
) {
	if (!complete)
		return locale === 'fr'
			? 'Aucun avis dans le bilan disponible pour ces dates.'
			: 'No notices in the available record for these dates.';
	if (locale === 'en') {
		return `${agency.name} published no alert${scope === 'network' ? '' : ` for this ${scope}`} on these dates.`;
	}
	const subject = frenchAgency(agency).subject;
	const forScope = { stop: ' pour cet arrêt', line: ' pour cette ligne', network: '' }[scope];
	return `${subject.charAt(0).toLocaleUpperCase('fr')}${subject.slice(1)} n’a publié aucun avis${forScope} à ces dates.`;
}

export function tripsInHours(trips: number, hours: number, locale: Locale): string {
	const format = intl.number(locale);
	return presenterCopy[locale].tripsInHours(
		format.format(trips),
		format.format(hours),
		singularCount(trips, locale),
		singularCount(hours, locale),
	);
}

/** Registry descriptions can document raw sub-minute inputs and export columns. */
export function registryUnitText(text: string, locale: Locale) {
	return presenterCopy[locale].registryUnitText(text);
}

export function recordStamp(period: { from: string; to: string }, locale: Locale) {
	return `${locale === 'fr' ? 'Bilan' : 'Record'} · ${dateRange(period, locale)}`;
}

export function recordPercent(value: number, locale: Locale) {
	return intl
		.number(locale, {
			style: 'percent',
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		})
		.format(value);
}

export function rankingComparison(
	range: { lower: number | null; upper: number | null },
	reference: { value: number; methodVersion: string } | null,
	methodVersion: string,
	worseIsHigher: boolean,
	locale: Locale,
): string | null {
	if (
		!reference ||
		reference.methodVersion !== methodVersion ||
		range.lower == null ||
		range.upper == null
	)
		return null;
	const higher = range.lower > reference.value;
	const lower = range.upper < reference.value;
	if (!higher && !lower)
		return locale === 'fr' ? 'Comme le réseau' : 'About the same as the network';
	if (higher === worseIsHigher)
		return locale === 'fr' ? 'Moins bien que le réseau' : 'Worse than the network';
	return locale === 'fr' ? 'Mieux que le réseau' : 'Better than the network';
}

export function countedUnit(
	value: number,
	unit: 'line' | 'stop' | 'event' | 'trip' | 'day' | 'vehicle' | 'distinct-alert' | 'measured-day',
	locale: Locale,
) {
	const labels = {
		line: { en: ['line', 'lines'], fr: ['ligne', 'lignes'] },
		stop: { en: ['stop', 'stops'], fr: ['arrêt', 'arrêts'] },
		event: { en: ['stop event', 'stop events'], fr: ['passage à un arrêt', 'passages aux arrêts'] },
		trip: { en: ['trip', 'trips'], fr: ['trajet', 'trajets'] },
		day: { en: ['day', 'days'], fr: ['jour', 'jours'] },
		'measured-day': { en: ['measured day', 'measured days'], fr: ['jour mesuré', 'jours mesurés'] },
		vehicle: { en: ['vehicle', 'vehicles'], fr: ['véhicule', 'véhicules'] },
		'distinct-alert': {
			en: ['distinct alert', 'distinct alerts'],
			fr: ['avis distinct', 'avis distincts'],
		},
	};
	if (locale === 'fr' && value === 0 && unit === 'event') return 'aucun passage aux arrêts';
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
		const unknown = stampCopy[locale].live('data', 'unknown', null, livePause.paused);
		return `${unknown} · ${locale === 'fr' ? 'pas à jour' : 'not current'}`;
	}
	return stampCopy[locale].live(
		'data',
		state,
		seconds == null ? null : formatRelativeSeconds(seconds, locale),
		livePause.paused,
	);
}

/**
 * Props for a live stamp that counts its age up each second. While live updates are paused it
 * keeps the age it had when it was drawn and says so: "Paused · updated 2 minutes ago".
 */
export function tickingLiveStamp(
	updatedAt: Date,
	locale: Locale,
	options: { label?: string; late?: boolean } = {},
): StampProps {
	const late = options.late ?? false;
	const age = Number.isFinite(+updatedAt) ? Math.max(0, (Date.now() - +updatedAt) / 1000) : null;
	if (livePause.paused && age !== null && !late)
		return { kind: 'live', label: liveStampAge(age, locale), late };
	return {
		kind: 'live',
		label:
			options.label ??
			(age === null
				? stampCopy[locale].live('data', 'unknown', null, livePause.paused)
				: liveStampAge(age, locale)),
		updatedAt,
		agoLabel: (seconds: number) => liveStampAge(seconds, locale),
		late,
	};
}

export function sampleWithMinimum(sample: string, minimum: number, locale: Locale) {
	const number = intl.number(locale).format(minimum);
	return `${sample} (${locale === 'fr' ? 'minimum de' : 'minimum'} ${number})`;
}

/**
 * What a vehicle's reporting interruptions mean, after their count: "times it stopped reporting,
 * about 2.4 an hour". The rate per 100 hours stays on How we measure. Without a count the rate
 * leads: "About 2.4 times an hour it stopped reporting".
 */
export function reportingGapsReading(
	per100Hours: number | null | undefined,
	gaps: number | null | undefined,
	locale: Locale,
) {
	const fr = locale === 'fr';
	const rate =
		per100Hours == null || !Number.isFinite(per100Hours)
			? null
			: intl.number(locale, { maximumFractionDigits: 1 }).format(per100Hours / 100);
	if (gaps == null)
		return rate == null
			? null
			: fr
				? `Environ ${rate} interruptions des signalements par heure`
				: `About ${rate} times an hour it stopped reporting`;
	const what = fr
		? singularCount(gaps, locale)
			? 'interruption des signalements'
			: 'interruptions des signalements'
		: gaps === 1
			? 'time it stopped reporting'
			: 'times it stopped reporting';
	if (rate == null) return what;
	return fr ? `${what}, environ ${rate} par heure` : `${what}, about ${rate} an hour`;
}

/** Vehicle time in whole hours ("596 h"); under ten hours it keeps a tenth ("2.5 h"). */
export function vehicleHours(seconds: number, locale: Locale) {
	const hours = seconds / 3600;
	const digits = hours < 10 ? 1 : 0;
	return `${intl.number(locale, { maximumFractionDigits: digits }).format(hours)}\u00a0h`;
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

export function captureAge(capturedAt: string | null, now: number, locale: Locale) {
	const seconds = capturedAt === null ? NaN : (now - Date.parse(capturedAt)) / 1000;
	return Number.isFinite(seconds) && seconds >= -5
		? formatRelativeSeconds(Math.max(0, seconds), locale).replace(/\bminutes?\b/u, 'min')
		: null;
}

export function captureCadence(seconds: number | null | undefined, locale: Locale) {
	if (seconds == null || !Number.isFinite(seconds)) return null;
	if (seconds === 86_400) return locale === 'fr' ? 'une fois par jour' : 'once a day';
	if (seconds === 1 && locale === 'fr') return 'chaque seconde';
	const interval =
		seconds < 90 ? `${intl.number(locale).format(seconds)} s` : minuteReading(seconds / 60, locale);
	return locale === 'fr' ? `toutes les ${interval}` : `every ${interval}`;
}

export function captureSize(bytes: number | null | undefined, locale: Locale) {
	if (bytes == null) return null;
	const [scale, unit] =
		bytes >= 1_000_000 ? [1_000_000, 'megabyte'] : bytes >= 1000 ? [1000, 'kilobyte'] : [1, 'byte'];
	return intl
		.number(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 })
		.format(bytes / scale);
}

export function healthFeedName(
	family: 'vehicle_positions' | 'trip_updates' | 'alerts',
	locale: Locale,
) {
	const names = {
		vehicle_positions: { en: 'Vehicle positions', fr: 'Positions des véhicules' },
		trip_updates: { en: 'Trip updates', fr: 'Mises à jour des trajets' },
		alerts: { en: 'Service alerts', fr: 'Avis de service' },
	};
	return names[family][locale];
}

export function healthTableDays(days: readonly { tables: Record<string, { status: string }> }[]) {
	const totals = { present: 0, missing: 0, notMeasured: 0, tracked: 0 };
	for (const { tables } of days) {
		for (const { status } of Object.values(tables)) {
			if (status === 'not_tracked') continue;
			totals.tracked++;
			if (status === 'present') totals.present++;
			else if (status === 'missing' || status === 'incomplete') totals.missing++;
			else totals.notMeasured++;
		}
	}
	return totals;
}

export function liveDelayLabels(locale: Locale) {
	const { band, delayUnknown } = transitTerms[locale];
	return { early: band.early, on_time: band.onTime, late: band.late, unknown: delayUnknown };
}

export function lineVehicleSentence(
	counts: Record<keyof ReturnType<typeof liveDelayLabels>, number>,
	locale: Locale,
) {
	const count = (value: number) => searchCount(value, locale);
	const total = counts.early + counts.on_time + counts.late + counts.unknown;
	if (total === 0)
		return locale === 'fr'
			? 'véhicule en service sur cette ligne en ce moment.'
			: 'vehicles are running on this line now.';
	const one = singularCount(total, locale);
	if (locale === 'fr') {
		return `${one ? 'véhicule circule' : 'véhicules circulent'} sur cette ligne en ce moment\u00a0: ${count(counts.early)} en avance, ${count(counts.on_time)} à l’heure, ${count(counts.late)} en retard${counts.unknown ? `, ${count(counts.unknown)} dont le retard est inconnu` : ''}.`;
	}
	return `${one ? 'vehicle is' : 'vehicles are'} running on this line now: ${count(counts.early)} early, ${count(counts.on_time)} on time, ${count(counts.late)} late${counts.unknown ? `, ${count(counts.unknown)} with delay unknown` : ''}.`;
}

/**
 * A stop with no vehicle in the next 15 minutes answers with the next one instead of a zero:
 * "No vehicle in the next 15 minutes. Next: line 361 toward Nord, scheduled 04:34."
 */
export function stopNextVehicleSentence(
	next: { line: string | null; toward: string | null; scheduled: string | null },
	locale: Locale,
) {
	const fr = locale === 'fr';
	const parts = [
		next.line ? (fr ? `ligne ${next.line}` : `line ${next.line}`) : null,
		next.toward ? (fr ? `vers ${next.toward}` : `toward ${next.toward}`) : null,
	].filter(Boolean);
	const where = parts.join(' ');
	const when = next.scheduled
		? fr
			? `prévu à ${next.scheduled}`
			: `scheduled ${next.scheduled}`
		: null;
	const detail = [where || null, when].filter(Boolean).join(', ');
	const lead = fr
		? 'Aucun véhicule dans les 15 prochaines minutes.'
		: 'No vehicle in the next 15 minutes.';
	if (!detail) return lead;
	return fr ? `${lead} Prochain\u00a0: ${detail}.` : `${lead} Next: ${detail}.`;
}

/**
 * A line with no vehicle reporting says so in words. Before the day's first scheduled trip it
 * names that trip; otherwise it says only what the feed shows.
 */
export function lineNoVehicleSentence(firstTrip: string | null, locale: Locale) {
	if (firstTrip)
		return locale === 'fr'
			? `Aucun trajet en cours. Premier trajet à ${firstTrip}.`
			: `No trip is running now. First trip at ${firstTrip}.`;
	return locale === 'fr'
		? 'Aucun véhicule ne transmet sa position sur cette ligne en ce moment.'
		: 'No vehicle is reporting on this line now.';
}

export function predictedIn(predictedAt: number, now: number, locale: Locale) {
	const left = Math.max(0, Math.ceil((predictedAt - now) / 60_000));
	// "in 0 min" reads as a machine; a vehicle due within the minute is due now.
	if (left === 0) return locale === 'fr' ? 'maintenant' : 'now';
	const minutes = minuteReading(left, locale);
	return locale === 'fr' ? `dans ${minutes}` : `in ${minutes}`;
}

/** Labels for the five columns that add up to the scheduled trips. */
export function tripOutcomeLabels(locale: Locale) {
	return locale === 'fr'
		? {
				scheduled: 'Trajets prévus',
				noLiveData: 'Sans données en direct',
				statusUnknown: 'État inconnu',
				known: 'État connu',
				ran: 'Effectués',
				cancelled: 'Annulés, avec avis de la société de transport',
				missing: 'Manquants, sans véhicule ni avis',
			}
		: {
				scheduled: 'Scheduled trips',
				noLiveData: 'No live data',
				statusUnknown: 'Status unknown',
				known: 'Known status',
				ran: 'Ran',
				cancelled: 'Cancelled, announced by the agency',
				missing: 'Missing, no vehicle and no notice',
			};
}

/** Short column headers for the day-by-day table. */
export function tripOutcomeHeaders(locale: Locale) {
	return locale === 'fr'
		? {
				scheduled: 'Prévus',
				noLiveData: 'Sans données en direct',
				statusUnknown: 'État inconnu',
				ran: 'Effectués',
				cancelled: 'Annulés',
				missing: 'Manquants',
			}
		: {
				scheduled: 'Scheduled',
				noLiveData: 'No live data',
				statusUnknown: 'Status unknown',
				ran: 'Ran',
				cancelled: 'Cancelled',
				missing: 'Missing',
			};
}

/** What the two columns outside the rate mean, in plain words. */
export function tripOutcomeNote(locale: Locale) {
	return locale === 'fr'
		? 'Sans données en direct : lignes pour lesquelles la société de transport ne publie aucune donnée en direct. État inconnu : aucun arrêt du trajet n’a été confirmé, il ne compte donc ni comme effectué ni comme manquant. Le taux porte sur les trajets à l’état connu.'
		: 'No live data: lines the agency publishes no live data for. Status unknown: no stop of the trip was confirmed, so it counts as neither run nor missing. The rate counts the trips with a known status.';
}

/** "105,961 of the 106,816 trips with a known status" */
export function tripsRunBase(ran: number, known: number, locale: Locale) {
	const count = intl.number(locale).format(ran);
	const base = intl.number(locale).format(known);
	return locale === 'fr'
		? `${count} des ${base} trajets à l’état connu`
		: `${count} of the ${base} trips with a known status`;
}

/** "99.2% of the 106,816 trips with a known status ran." without the figure. */
export function tripsRunSentence(known: number | null | undefined, locale: Locale) {
	if (known == null)
		return locale === 'fr'
			? 'des trajets prévus dont l’état est connu ont été effectués'
			: 'of scheduled trips with a known status ran';
	const base = intl.number(locale).format(known);
	return locale === 'fr'
		? `des ${base} trajets à l’état connu ont été effectués`
		: `of the ${base} trips with a known status ran`;
}

/**
 * Why an entity under its low-coverage limit is left out of a ranking:
 * "Low coverage: 33.1% of scheduled stop events observed".
 */
export function lowCoverageReason(
	evidence: {
		share_observed?: number | null;
		share_eligible?: number | null;
		counts?: Record<string, number | null> | null;
	},
	locale: Locale,
) {
	const label = locale === 'fr' ? 'Faible couverture' : 'Low coverage';
	const fr = locale === 'fr';
	let detail = '';
	if (evidence.share_eligible != null) {
		const rate = recordPercent(evidence.share_eligible, locale);
		detail = fr
			? `état connu pour ${rate} des trajets prévus`
			: `status known for ${rate} of scheduled trips`;
	} else if (evidence.share_observed != null) {
		const rate = recordPercent(evidence.share_observed, locale);
		detail =
			evidence.counts?.frequent_headways != null
				? fr
					? `${rate} des intervalles prévus observés`
					: `${rate} of scheduled intervals observed`
				: fr
					? `${rate} des passages prévus observés`
					: `${rate} of scheduled stop events observed`;
	}
	return detail ? `${label}${fr ? ' : ' : ': '}${detail}` : label;
}

/**
 * An agency's name with the French form its city declares after "de" (the source line of its
 * download licence). The subject form comes from that declared form; a city that declares none
 * keeps its bare name.
 */
export type AgencyName = { name: string; frenchOf?: string | null };

export function agencyName(
	name: string,
	provider?: { download_licence?: { source?: { fr: string } } | null } | null,
): AgencyName {
	return { name, frenchOf: provider?.download_licence?.source?.fr ?? null };
}

const frenchContractions: [RegExp, string][] = [
	[/^de la /u, 'la '],
	[/^de l['’]/u, 'l’'],
	[/^du /u, 'le '],
	[/^des /u, 'les '],
	[/^d['’]/u, ''],
	[/^de /u, ''],
];

/**
 * The agency in a French sentence, from the form its city declares after "de": as its subject
 * ("la …" for a declared "de la …"), after "de", after "par" and "avec", and capitalized to start
 * a sentence.
 */
export function frenchAgency({ name, frenchOf }: AgencyName) {
	const declared = frenchOf?.trim();
	const rule = declared && frenchContractions.find(([pattern]) => pattern.test(declared));
	// Without a declared form, only French elision applies; no article is guessed.
	const subject = rule ? declared.replace(rule[0], rule[1]) : name;
	const of = rule
		? declared
		: /^[aeiouyhàâäéèêëîïôöùûüœ]/iu.test(name)
			? `d’${name}`
			: `de ${name}`;
	return {
		subject,
		of,
		by: `par ${subject}`,
		with: `avec ${subject}`,
		start: subject.charAt(0).toLocaleUpperCase('fr') + subject.slice(1),
	};
}

/** The one sentence for a city whose alerts Transit does not collect. */
export function alertsNotCollected(agency: AgencyName, locale: Locale) {
	return locale === 'fr'
		? `Transit ne collecte pas encore les avis ${frenchAgency(agency).of}.`
		: `Transit does not collect ${agency.name}’s alerts yet.`;
}

/** The state and its sentence on one line: "Not tracked: Transit does not collect …". */
export function alertsNotTrackedLine(agency: AgencyName, locale: Locale) {
	return locale === 'fr'
		? `Non suivi\u00a0: ${alertsNotCollected(agency, locale)}`
		: `Not tracked: ${alertsNotCollected(agency, locale)}`;
}

/** A city whose alerts Transit collects, on dates the record holds none of them. */
export function alertsNotTrackedOnDates(agency: AgencyName, locale: Locale) {
	return locale === 'fr'
		? `Non suivi\u00a0: Transit n’a pas collecté les avis ${frenchAgency(agency).of} à ces dates.`
		: `Not tracked: Transit did not collect ${agency.name}’s alerts on these dates.`;
}

export function officialAlertsLabel(locale: Locale) {
	return locale === 'fr' ? 'Consulter les avis officiels' : 'Check official service alerts';
}

/** The citation for a whole page: who published it, what, which dates and where to find it. */
export function pageCitation(
	subject: string,
	period: { from: string; to: string } | null | undefined,
	href: string,
	locale: Locale,
): string {
	return [`Transit · ${subject}.`, period ? `${citeDates(period, locale)}.` : '', href]
		.filter(Boolean)
		.join(' ');
}

/** Dates that begin a sentence of cite text: "Du 19 au 25 nov. 2026." in French. */
export function citeDates(period: { from: string; to: string }, locale: Locale): string {
	return sentenceStart(dateRange(period, locale));
}

/** A sentence's first letter in capitals, as when generated text opens it. */
export function sentenceStart(text: string): string {
	return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/** The muted second line of a phone row: the secondary facts as one sentence, no labels. */
export function rowSentence(parts: readonly (string | null | undefined | false)[], locale: Locale) {
	const text = parts.filter(Boolean).join(', ');
	return text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : null;
}

export function lateShare(value: number, locale: Locale) {
	return `${locale === 'fr' ? 'en retard' : 'late'} ${recordPercent(value, locale)}`;
}

export function tripsRan(ran: number, scheduled: number, locale: Locale) {
	const total = intl.number(locale).format(scheduled);
	return locale === 'fr'
		? `${recordRatio(ran, total, locale)} trajets effectués`
		: `${recordRatio(ran, total, locale)} trips ran`;
}

export function daysInService(days: number, periodDays: number | null, locale: Locale) {
	const count = periodDays
		? recordRatio(days, intl.number(locale).format(periodDays), locale)
		: intl.number(locale).format(days);
	const one = !periodDays && singularCount(days, locale);
	return `${count} ${locale === 'fr' ? (one ? 'jour' : 'jours') : one ? 'day' : 'days'}`;
}

export function hoursInService(hours: number, locale: Locale) {
	return `${hoursReading(hours, locale)} ${locale === 'fr' ? 'en service' : 'in service'}`;
}

export function didNotReport(locale: Locale) {
	return locale === 'fr' ? 'Aucun signalement pour ces dates.' : 'Did not report on these dates.';
}

export function lastReport(age: string, locale: Locale) {
	return locale === 'fr' ? `dernier signalement ${age}` : `last report ${age}`;
}

/** A feed's capture facts as one phone-row sentence. */
export function captureFacts(
	age: string | null | undefined,
	cadence: string | null | undefined,
	size: string | null | undefined,
	locale: Locale,
) {
	const fr = locale === 'fr';
	return rowSentence(
		[
			age && (fr ? `relevé ${age}` : `captured ${age}`),
			cadence && (fr ? `prévu ${cadence}` : `expected ${cadence}`),
			size,
		],
		locale,
	);
}

export function departureAt(clock: string, locale: Locale) {
	return `${locale === 'fr' ? 'départ' : 'departure'} ${clock}`;
}

/** Cancelled and missing trips of one service day, as a phone-row sentence. */
export function deliveryFacts(cancelled: number | null, missing: number | null, locale: Locale) {
	const count = (value: number) => intl.number(locale).format(value);
	const fr = locale === 'fr';
	return rowSentence(
		[
			cancelled != null &&
				(fr
					? `${count(cancelled)} ${cancelled < 2 ? 'annulé' : 'annulés'}`
					: `${count(cancelled)} cancelled`),
			missing != null &&
				(fr
					? `${count(missing)} ${missing < 2 ? 'manquant' : 'manquants'}`
					: `${count(missing)} missing`),
		],
		locale,
	);
}

/** One sentence for a departure table whose every row is too few to judge. */
export function tooFewDepartures(most: number, minimum: number | null, locale: Locale) {
	const count = (value: number) => intl.number(locale).format(value);
	if (locale === 'fr')
		return `Chaque départ compte au plus ${count(most)} ${most < 2 ? 'trajet prévu' : 'trajets prévus'}${minimum == null ? '' : `, sur un minimum de ${count(minimum)}`}.`;
	return `Each departure has at most ${count(most)} scheduled ${most === 1 ? 'trip' : 'trips'}${minimum == null ? '' : `; the minimum is ${count(minimum)}`}.`;
}

export function showAllStops(count: number, locale: Locale) {
	const number = intl.number(locale).format(count);
	return locale === 'fr' ? `Afficher les ${number} arrêts` : `Show all ${number} stops`;
}

export function gridDaysNote(days: number, locale: Locale) {
	const count = intl.number(locale).format(days);
	return locale === 'fr'
		? `La grille montre les ${count} derniers jours. Les totaux couvrent toute la période.`
		: `The grid shows the last ${count} days. The counts cover the full period.`;
}

/** One sentence for an hour grid whose every reading is too few to judge. */
export function tooFewHours(most: number, minimum: number | null, locale: Locale) {
	const count = (value: number) => intl.number(locale).format(value);
	if (locale === 'fr')
		return `Chaque heure compte trop peu de passages aux arrêts pour conclure\u00a0: au plus ${count(most)}${minimum == null ? '' : `, sur un minimum de ${count(minimum)}`}.`;
	return `Every hour has too few stop events to judge: at most ${count(most)}${minimum == null ? '' : `; the minimum is ${count(minimum)}`}.`;
}

/**
 * Count templates with the number already formatted ("8,630 stops", "8 630 arrêts"). The kit's
 * filterCountText fills `{count}` with the bare number, so the templates arrive pre-filled.
 */
export function countLabels(
	count: number,
	labels: { singular: string; plural: string },
	locale: Locale,
) {
	const number = intl.number(locale).format(count);
	return {
		singular: labels.singular.replace('{count}', number),
		plural: labels.plural.replace('{count}', number),
	};
}
