import { expect, it } from 'vitest';
import { routeNameFallback } from './absence.ts';
import { createLineDirectory } from './lineDirectory.ts';
import {
	alertAnswerSentence,
	alertPaging,
	captureCadence,
	clockRange,
	clockTime,
	dateAndClock,
	dateRange,
	countedUnit,
	dailyAlertsLink,
	delayReading,
	directionLabel,
	fileSize,
	liveStampAge,
	longDate,
	mapRecordReading,
	dailyReportTitle,
	methodEvidence,
	minuteReading,
	registryUnitText,
	recordRatio,
	recordPercent,
	rankingComparison,
	recordStamp,
	scheduledClock,
	serviceTime,
	tripsInHours,
	vehiclePositionsCapture,
	versionNumber,
} from './presenter.ts';

it.each([
	[
		'en',
		'alert is in effect now.',
		'alerts were in effect at some point in these dates.',
		'Show 12 more',
		'Showing 12 of 426',
	],
	[
		'fr',
		'avis est en vigueur.',
		'avis ont été en vigueur à un moment de cette période.',
		'Afficher 12 de plus',
		'12 sur 426',
	],
] as const)('formats alert counts and paging in %s', (locale, singular, plural, more, showing) => {
	expect(alertAnswerSentence(1, locale, true)).toBe(singular);
	expect(alertAnswerSentence(426, locale, false)).toBe(plural);
	expect(alertPaging(locale).more(12)).toBe(more);
	expect(alertPaging(locale).showing(12, 426)).toBe(showing);
});

const normalize = (text: string | null) => text?.replaceAll('\u00a0', ' ');

it('uses the published interval and a matching reference method for the ranking verdict', () => {
	const network = { value: 0.8, methodVersion: 'on-time-v3' };
	expect(rankingComparison({ lower: 0.5, upper: 0.7 }, network, 'on-time-v3', false, 'en')).toBe(
		'Worse than the network',
	);
	expect(rankingComparison({ lower: 0.5, upper: 0.7 }, network, 'on-time-v3', true, 'fr')).toBe(
		'Mieux que le réseau',
	);
	expect(rankingComparison({ lower: 0.8, upper: 0.9 }, network, 'on-time-v3', true, 'fr')).toBe(
		'Comme le réseau',
	);
	expect(rankingComparison({ lower: 0.81, upper: 0.9 }, network, 'on-time-v3', true, 'fr')).toBe(
		'Moins bien que le réseau',
	);
	expect(
		rankingComparison({ lower: 0.81, upper: 0.9 }, network, 'on-time-v2', true, 'en'),
	).toBeNull();
	expect(
		rankingComparison({ lower: null, upper: null }, network, 'on-time-v3', true, 'en'),
	).toBeNull();
});

it.each([
	['en', '0.0%', '14.0%', '80.7%'],
	['fr', '0,0 %', '14,0 %', '80,7 %'],
] as const)('formats measured shares with one decimal in %s', (locale, zero, whole, fraction) => {
	expect(normalize(recordPercent(0, locale))).toBe(zero);
	expect(normalize(recordPercent(0.14, locale))).toBe(whole);
	expect(normalize(recordPercent(0.807, locale))).toBe(fraction);
});

it.each([
	['en', 'every 89 s', 'every 1.5 min', 'every 5 min', 'once a day'],
	['fr', 'toutes les 89 s', 'toutes les 1,5 min', 'toutes les 5 min', 'une fois par jour'],
] as const)(
	'shows capture cadence in seconds and minutes in %s',
	(locale, short, boundary, long, daily) => {
		expect(normalize(captureCadence(89, locale))).toBe(short);
		expect(normalize(captureCadence(90, locale))).toBe(boundary);
		expect(normalize(captureCadence(300, locale))).toBe(long);
		expect(captureCadence(86_400, locale)).toBe(daily);
		expect(captureCadence(null, locale)).toBeNull();
	},
);

it.each([
	['en', '1 distinct alert', '2 distinct alerts', 'See the service alert'],
	['fr', '1 avis distinct', '2 avis distincts', 'Voir l’avis de service'],
] as const)('presents the Daily alert count and link in %s', (locale, one, two, link) => {
	expect(countedUnit(1, 'distinct-alert', locale)).toBe(one);
	expect(countedUnit(2, 'distinct-alert', locale)).toBe(two);
	expect(dailyAlertsLink(1, locale)).toBe(link);
});

it.each([
	['en', '13 October 2026'],
	['fr', '13 octobre 2026'],
] as const)('writes the full day-first date in %s', (locale, expected) => {
	expect(longDate('2026-10-13', locale)).toBe(expected);
});

it.each([
	[
		'en',
		'Record · 16 to 22 Nov 2026',
		'1 stop',
		'1,234 of 2,000 stop events',
		'Live · updated 20 s ago',
	],
	[
		'fr',
		'Bilan · du 16 au 22 nov. 2026',
		'1 arrêt',
		'1 234 sur 2 000 passages aux arrêts',
		'En direct · mis à jour il y a 20 s',
	],
] as const)('presents record and live readings in %s', (locale, stamp, stop, counts, age) => {
	expect(recordStamp({ from: '2026-11-16', to: '2026-11-22' }, locale)).toBe(stamp);
	expect(countedUnit(1, 'stop', locale)).toBe(stop);
	expect(recordRatio(1234, countedUnit(2000, 'event', locale), locale).replace(/\s/g, ' ')).toBe(
		counts,
	);
	expect(liveStampAge(20, locale)).toBe(age);
	expect(liveStampAge(75, locale)).toBe(
		locale === 'en' ? 'Live · updated 1 minute ago' : 'En direct · mis à jour il y a 1 minute',
	);
});

it.each([
	['en', '5.9 min late', '1 min early', 'On schedule', 'Delay unknown', '+5.9 min'],
	['fr', '5,9 min de retard', '1 min d’avance', 'À l’heure prévue', 'Retard inconnu', '+5,9 min'],
] as const)(
	'reads delays and absence in %s',
	(locale, late, early, onSchedule, unknown, signed) => {
		expect(normalize(delayReading(352, locale))).toBe(late);
		expect(normalize(delayReading(-61, locale))).toBe(early);
		expect(delayReading(0, locale)).toBe(onSchedule);
		expect(delayReading(null, locale)).toBe(unknown);
		expect(delayReading(NaN, locale, 'Unavailable')).toBe('Unavailable');
		expect(normalize(minuteReading(352 / 60, locale, true))).toBe(signed);
		expect(minuteReading(null, locale, true)).toBeNull();
	},
);

it.each([
	['en', '00:48, next day', 'Unknown time'],
	['fr', '00:48, le lendemain', 'Heure inconnue'],
] as const)('displays service clocks and absence in %s', (locale, nextDay, unknown) => {
	expect(serviceTime('16:38:52', locale)).toBe('16:38');
	expect(serviceTime('24:48:00', locale)).toBe(nextDay);
	expect(serviceTime('00:48:00', locale)).toBe('00:48');
	expect(serviceTime('24:60:00', locale)).toBeNull();
	expect(serviceTime(null, locale)).toBeNull();
	expect(scheduledClock(null, locale)).toBe(unknown);
});

it.each(['en', 'fr'] as const)(
	'renders instants in the selected city across DST in %s',
	(locale) => {
		const time = (iso: string, zone = 'America/Los_Angeles') =>
			clockTime(new Date(iso), locale, zone);
		expect(time('2026-03-08T09:59:59Z')).toBe('01:59');
		expect(time('2026-03-08T10:00:00Z')).toBe('03:00');
		expect(time('2026-11-01T08:48:00Z')).toBe('01:48');
		expect(time('2026-11-01T09:48:00Z')).toBe('01:48');
		expect(time('2026-11-01T09:48:00Z', 'America/Toronto')).toBe('04:48');
		expect(time('2026-11-01T07:00:00Z')).toBe('00:00');
		expect(dateAndClock('2026-11-01T09:48:00Z', locale, 'America/Los_Angeles', true)).toContain(
			'01:48',
		);
	},
);

it.each([
	['en', 'Toward Station Laurier', 'Unknown direction', 'Line X'],
	['fr', 'Vers Station Laurier', 'Direction inconnue', 'Ligne X'],
] as const)(
	'uses schedule names when available in %s',
	(locale, destination, unknown, fallback) => {
		expect(directionLabel(0, { 0: ' Station Laurier ' }, locale)).toBe(destination);
		expect(directionLabel(0, {}, locale)).toBe(unknown);
		expect(directionLabel(null, { 0: 'Station Laurier' }, locale)).toBe(unknown);
		const directory = createLineDirectory([{ id: '24E', short: '24', long: 'Sherbrooke' }], {
			line: (id) => routeNameFallback(id, locale),
		});
		expect(directory.name('24E').label).toBe('24 · Sherbrooke');
		expect(directory.name('24E', '24').label).toBe('24');
		expect(directory.name('X').label).toBe(fallback);
	},
);

it.each([
	['en', '16 to 22 Nov 2026', '31 Dec 2026 to 1 Jan 2027', '22 Nov 2026'],
	['fr', 'du 16 au 22 nov. 2026', 'du 31 déc. 2026 au 1 janv. 2027', '22 nov. 2026'],
] as const)('formats calendar ranges in %s', (locale, week, yearBoundary, oneDay) => {
	expect(dateRange({ from: '2026-11-16', to: '2026-11-22' }, locale)).toBe(week);
	expect(dateRange({ from: '2026-12-31', to: '2027-01-01' }, locale)).toBe(yearBoundary);
	expect(dateRange({ from: '2026-11-22', to: '2026-11-22' }, locale)).toBe(oneDay);
});

it.each([
	[
		'en',
		'4.76 MB',
		'Method v3, cleaning v11.',
		'Method v3, cleaning unknown.',
		'465 trips in 20 hours',
	],
	[
		'fr',
		'4,76 Mo',
		'Méthode v3, nettoyage v11.',
		'Méthode v3, nettoyage inconnu.',
		'465 trajets en 20 heures',
	],
] as const)(
	'formats sizes, versions and service counts in %s',
	(locale, size, versions, unknown, count) => {
		expect(normalize(fileSize(4_758_631, locale))).toBe(size);
		expect(fileSize(null, locale)).toBeNull();
		expect(
			methodEvidence({ method_version: 'punctuality-v3', cleaning_versions: [11] }, locale),
		).toBe(versions);
		expect(methodEvidence({ method_version: '3', cleaning_versions: [] }, locale)).toBe(unknown);
		expect(versionNumber(null)).toBeNull();
		expect(tripsInHours(465, 20, locale)).toBe(count);
	},
);

it('keeps technical raw units legible without using them for the on-time thresholds', () => {
	expect(registryUnitText('60 seconds early to 300 seconds late', 'en')).toBe(
		'1 minute early to 5 minutes late',
	);
	expect(registryUnitText('60 secondes d’avance à 300 secondes de retard', 'fr')).toBe(
		'1 minute d’avance à 5 minutes de retard',
	);
});

it.each(['en', 'fr'] as const)('shares the date across a same-day alert period in %s', (locale) => {
	const start = '2026-11-22T04:30:00Z';
	const end = '2026-11-22T04:45:00Z';
	const zone = 'America/Toronto';
	const from = dateAndClock(start, locale, zone);
	expect(clockRange(start, end, locale, zone)).toBe(from + '–23:45');
	const nextDay = '2026-11-22T05:15:00Z';
	expect(clockRange(start, nextDay, locale, zone)).toBe(
		from + '–' + dateAndClock(nextDay, locale, zone),
	);
	expect(tripsInHours(1, 1, locale)).toBe(
		locale === 'fr' ? '1 trajet en 1 heure' : '1 trip in 1 hour',
	);
});

it.each([
	['en', 8, 'Vehicle positions: 8 s ago.'],
	['fr', 8, 'Positions des véhicules : il y a 8 s.'],
	['en', 0, 'Vehicle positions: now.'],
	['fr', 0, 'Positions des véhicules : à l’instant.'],
] as const)(
	'writes a complete vehicle capture sentence in %s at %i seconds',
	(locale, age, expected) => {
		expect(vehiclePositionsCapture(age, locale).replace(/[\u00a0\u202f]/g, ' ')).toBe(expected);
	},
);
it.each([
	['en', '2026-11-25', '2026-11-25', 'Report for Wednesday 25 November 2026'],
	['fr', '2026-11-25', '2026-11-25', 'Rapport du mercredi 25 novembre 2026'],
	['en', '2026-11-16', '2026-11-22', 'Report for 16 to 22 November 2026'],
	['fr', '2026-11-16', '2026-11-22', 'Rapport du 16 au 22 novembre 2026'],
] as const)('formats the dated report title in %s (%s to %s)', (locale, from, to, title) => {
	expect(dailyReportTitle({ from, to }, locale)).toBe(title);
});

it.each([
	['en', 202, true, '20.2%'],
	['fr', 202, true, '20,2\u00a0%'],
	['en', 42, false, '0.7 min'],
	['en', 45, false, '0.8 min'],
	['fr', 45, false, '0,8 min'],
	['en', 258, false, '4.3 min'],
] as const)('formats %s map reading %s', (locale, value, stops, expected) => {
	expect(mapRecordReading(value, stops, locale)).toBe(expected);
});
