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

export function mapRecordReading(value: number, stops: boolean, locale: Locale): string | null {
	if (stops)
		return intl
			.number(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
			.format(value / 1000);
	return `${intl.number(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 60)} min`;
}

export function mapDirectionReading(name: string, locale: Locale): string {
	return `${locale === 'fr' ? 'vers' : 'toward'} ${directionName(name, locale)}`;
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

export function alertAnswerSentence(count: number, locale: Locale, live: boolean) {
	if (locale === 'fr') {
		if (live) return count === 1 ? `avis est en vigueur.` : `avis sont en vigueur.`;
		return count === 1
			? `avis a été en vigueur à un moment de cette période.`
			: `avis ont été en vigueur à un moment de cette période.`;
	}
	if (live) return count === 1 ? 'alert is in effect now.' : 'alerts are in effect now.';
	return count === 1
		? 'alert was in effect at some point in these dates.'
		: 'alerts were in effect at some point in these dates.';
}

export function dailyAlertsLink(count: number, locale: Locale) {
	const number = intl.number(locale).format(count);
	if (count === 1) return locale === 'fr' ? 'Voir l’avis de service' : 'See the service alert';
	return locale === 'fr'
		? `Les ${number} dans les avis de service`
		: `All ${number} in Service alerts`;
}

export function alertPaging(locale: Locale) {
	const { format } = intl.number(locale);
	return {
		showing: (shown: number, total: number) =>
			locale === 'fr'
				? `${format(shown)} sur ${format(total)}`
				: `Showing ${format(shown)} of ${format(total)}`,
		more: (count: number) =>
			locale === 'fr' ? `Afficher ${format(count)} de plus` : `Show ${format(count)} more`,
	};
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
	return name?.trim() ? copy.toward(directionName(name, locale, rule)) : copy.unknownDirection;
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
	return [clockFace(start, 0), clockFace(end, 0)].join(locale === 'fr' ? ' à ' : ' to ');
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
	const one = total === 1;
	if (locale === 'fr') {
		return `${one ? 'véhicule circule' : 'véhicules circulent'} sur cette ligne en ce moment : ${count(counts.early)} en avance, ${count(counts.on_time)} à l’heure, ${count(counts.late)} en retard${counts.unknown ? `, ${count(counts.unknown)} au retard inconnu` : ''}.`;
	}
	return `${one ? 'vehicle is' : 'vehicles are'} running on this line now: ${count(counts.early)} early, ${count(counts.on_time)} on time, ${count(counts.late)} late${counts.unknown ? `, ${count(counts.unknown)} with delay unknown` : ''}.`;
}

export function predictedIn(predictedAt: number, now: number, locale: Locale) {
	const minutes = minuteReading(Math.max(0, Math.ceil((predictedAt - now) / 60_000)), locale);
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
				cancelled: 'Annulés, avec avis de l’agence',
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
		? 'Sans données en direct : lignes pour lesquelles l’agence ne publie aucune donnée en direct. État inconnu : aucun arrêt du trajet n’a été confirmé, il ne compte donc ni comme effectué ni comme manquant. Le taux porte sur les trajets à l’état connu.'
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
