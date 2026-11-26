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
	citeDates,
	dateRange,
	pageCitation,
	countedUnit,
	dailyAlertsLink,
	delayReading,
	directionLabel,
	fileSize,
	lineRecordHeading,
	liveStampAge,
	liveStatusWords,
	lineNoVehicleSentence,
	stopNextVehicleSentence,
	tickingLiveStamp,
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
import { livePause } from '#lib/live/livePause.ts';

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
		expect(delayReading(2, locale)).toBe(onSchedule);
		expect(delayReading(-2, locale)).toBe(onSchedule);
		expect(normalize(delayReading(3, locale))).toBe(
			locale === 'en' ? '0.1 min late' : '0,1 min de retard',
		);
		expect(normalize(delayReading(-3, locale))).toBe(
			locale === 'en' ? '0.1 min early' : '0,1 min d’avance',
		);
		expect(delayReading(null, locale)).toBe(unknown);
		expect(delayReading(NaN, locale, 'Unavailable')).toBe('Unavailable');
		expect(normalize(minuteReading(352 / 60, locale, true))).toBe(signed);
		expect(minuteReading(null, locale, true)).toBeNull();
	},
);

it.each([
	['1', 'Ligne 1 - Verte', 'en', 'Line 1 Verte'],
	['1', 'line 1: Verte', 'fr', 'Ligne 1 Verte'],
	['1', 'Ligne 1 / Verte', 'fr', 'Ligne 1 Verte'],
	['1', 'Ligne 1', 'en', 'Line 1'],
	['1', 'Ligne 10 - Verte', 'en', 'Line 1 Ligne 10 - Verte'],
	['1', 'Ligne 1A', 'en', 'Line 1 Ligne 1A'],
	['1', 'Old Line 1', 'en', 'Line 1 Old Line 1'],
	['51', 'Édouard-Montpetit', 'en', 'Line 51 Édouard-Montpetit'],
	['A', 'Baker Street', 'en', 'Baker Street'],
] as const)(
	'presents line %s with the published name %s in %s',
	(number, name, locale, expected) => {
		expect(lineRecordHeading({ number, name, label: number }, locale)).toBe(expected);
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
	expect(registryUnitText('plus de 60 secondes d’avance', 'fr')).toBe('plus d’une minute d’avance');
	expect(registryUnitText('Reads a histogram in 15-second steps.', 'en')).toBe(
		'Reads a histogram in 15-s steps.',
	);
	expect(registryUnitText('tranches de 15 secondes', 'fr')).toBe('tranches de 15\u00a0s');
	expect(registryUnitText('Delay is signed seconds.', 'en')).toBe('Delay is signed seconds.');
	expect(registryUnitText('Secondes d’avis et classes d’une seconde.', 'fr')).toBe(
		'Secondes d’avis et classes d’une seconde.',
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

it.each([
	['en', 'On time', '(4 min behind)', '14 min late', '2 min early', '(0.5 min ahead)'],
	[
		'fr',
		'À l’heure',
		'(4 min de retard)',
		'14 min de retard',
		'2 min d’avance',
		'(0,5 min d’avance)',
	],
] as const)(
	'words a live status mark without repeating the band in %s',
	(locale, onTime, behind, late, early, ahead) => {
		const words = (status: 'early' | 'on_time' | 'late' | 'unknown', delay: number | null) =>
			liveStatusWords(status, status === 'on_time' ? onTime : 'Band', delay, locale);
		expect(words('on_time', 0)).toEqual({ label: onTime });
		expect(words('on_time', 240)).toEqual({ label: onTime, detail: behind });
		expect(words('on_time', -30)).toEqual({ label: onTime, detail: ahead });
		expect(words('late', 840)).toEqual({ label: late });
		expect(words('early', -120)).toEqual({ label: early });
		expect(words('unknown', null)).toEqual({ label: 'Band' });
		expect(words('late', null)).toEqual({ label: 'Band' });
	},
);

it.each([
	[
		'en',
		'No vehicle in the next 15 minutes. Next: line 361 toward Nord, scheduled 04:34.',
		'No vehicle in the next 15 minutes.',
		'No trip is running now. First trip at 04:48.',
		'No vehicle is reporting on this line now.',
	],
	[
		'fr',
		'Aucun véhicule dans les 15 prochaines minutes. Prochain : ligne 361 vers Nord, prévu à 04:34.',
		'Aucun véhicule dans les 15 prochaines minutes.',
		'Aucun trajet en cours. Premier trajet à 04:48.',
		'Aucun véhicule ne transmet sa position sur cette ligne en ce moment.',
	],
] as const)(
	'answers a quiet stop and line with what comes next, never a zero, in %s',
	(locale, next, bare, first, quiet) => {
		expect(
			stopNextVehicleSentence({ line: '361', toward: 'Nord', scheduled: '04:34' }, locale),
		).toBe(next);
		expect(stopNextVehicleSentence({ line: null, toward: null, scheduled: null }, locale)).toBe(
			bare,
		);
		expect(lineNoVehicleSentence('04:48', locale)).toBe(first);
		expect(lineNoVehicleSentence(null, locale)).toBe(quiet);
		for (const sentence of [next, bare, first, quiet]) expect(sentence).not.toMatch(/\b0\b|—/u);
	},
);

it.each([
	['en', 'Paused · updated 2 minutes ago', 'Live · updated 2 minutes ago'],
	['fr', 'En pause · mis à jour il y a 2 minutes', 'En direct · mis à jour il y a 2 minutes'],
] as const)(
	'says a paused live stamp is paused and stops its ticking, in %s',
	(locale, paused, live) => {
		livePause.reset();
		const updatedAt = new Date(Date.now() - 120_000);
		const ticking = tickingLiveStamp(updatedAt, locale);
		expect(ticking.agoLabel?.(120)).toBe(live);
		livePause.set(true);
		try {
			expect(liveStampAge(120, locale)).toBe(paused);
			const frozen = tickingLiveStamp(updatedAt, locale);
			expect(frozen.label).toBe(paused);
			expect(frozen.agoLabel).toBeUndefined();
			expect(frozen.updatedAt).toBeUndefined();
		} finally {
			livePause.reset();
		}
	},
);

it.each([
	['en', 'Transit · 24 · Sherbrooke. 19 to 25 Nov 2026. https://t.test/lines/24'],
	['fr', 'Transit · 24 · Sherbrooke. Du 19 au 25 nov. 2026. https://t.test/lines/24'],
] as const)('opens a %s citation sentence with a capital, even on a date', (locale, text) => {
	const period = { from: '2026-11-19', to: '2026-11-25' };
	expect(citeDates(period, locale)).toBe(
		locale === 'fr' ? 'Du 19 au 25 nov. 2026' : '19 to 25 Nov 2026',
	);
	expect(pageCitation('24 · Sherbrooke', period, 'https://t.test/lines/24', locale)).toBe(text);
	// Mid-sentence dates keep their lowercase.
	expect(dateRange(period, 'fr')).toBe('du 19 au 25 nov. 2026');
});
