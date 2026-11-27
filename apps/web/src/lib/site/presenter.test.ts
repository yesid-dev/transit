import { expect, it } from 'vitest';
import { routeNameFallback } from './absence.ts';
import { createLineDirectory } from './lineDirectory.ts';
import {
	agencyName,
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
	countLabels,
	daysInService,
	deliveryFacts,
	dailyAlertsLink,
	distanceReading,
	noticeCountEvidence,
	publishedAlertCount,
	delayReading,
	directionLabel,
	frenchAgency,
	lineSubtitle,
	plannedInterval,
	predictedIn,
	readerClock,
	riderHeadsign,
	scheduleHours,
	terminusName,
	towardReading,
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
	rowSentence,
	scheduledClock,
	serviceTime,
	tooFewDepartures,
	tooFewHours,
	tripsInHours,
	tripsRan,
	vehiclePositionsCapture,
	versionNumber,
} from './presenter.ts';
import { livePause } from '#lib/live/livePause.ts';

it.each([
	[
		'en',
		'notice is in effect now.',
		'notices were in effect at some point in these dates.',
		'Show 12 more',
		'Showing 12 of 426',
	],
	[
		'fr',
		'avis est en vigueur.',
		'avis étaient en vigueur à un moment donné à ces dates.',
		'Afficher 12 de plus',
		'12 sur 426',
	],
] as const)('formats alert counts and paging in %s', (locale, singular, plural, more, showing) => {
	expect(alertAnswerSentence(1, locale, true)).toBe(singular);
	expect(alertAnswerSentence(426, locale, false)).toBe(plural);
	expect(alertPaging(locale).more(12)).toBe(more);
	expect(alertPaging(locale).showing(12, 426)).toBe(showing);
	expect(alertPaging(locale, true).showing(12, 426)).toBe(
		locale === 'fr' ? '12 sur 426 avis' : 'Showing 12 of 426 notices',
	);
	expect(alertAnswerSentence(426, locale, false, true)).toBe(
		locale === 'fr' ? 'avis tels que publiés.' : 'notices as published.',
	);
});

const normalize = (text: string | null) => text?.replaceAll('\u00a0', ' ');

it('explains the grouped and published units only when their counts differ', () => {
	const agency = { name: 'STM', frenchOf: 'de la STM' };
	expect(noticeCountEvidence(213, 1707, agency, 'en')).toBe(
		'213 notices, from 1,707 as STM published them, one per line and reissue.',
	);
	expect(normalize(noticeCountEvidence(213, 1707, agency, 'fr'))).toBe(
		'213 avis, issus de 1 707 avis publiés par la STM, un par ligne et par mise à jour.',
	);
	expect(publishedAlertCount(1707, 'en')).toBe('1,707 notices as published');
	expect(normalize(publishedAlertCount(1707, 'fr'))).toBe('1 707 avis tels que publiés');
});

it.each([
	['en', '3 notices.'],
	['fr', '3 avis.'],
] as const)(
	'omits repeated publication detail when both alert counts match in %s',
	(locale, expected) => {
		const agency = { name: 'STM', frenchOf: 'de la STM' };
		expect(noticeCountEvidence(3, 3, agency, locale)).toBe(expected);
	},
);

it.each([
	['en', '100 m', '1.4 km'],
	['fr', '100\u00a0m', '1,4\u00a0km'],
] as const)('formats map distances in %s', (locale, metres, kilometres) => {
	expect(distanceReading(100, locale)).toBe(metres);
	expect(distanceReading(1400, locale)).toBe(kilometres);
});

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
	['en', '1 distinct notice', '2 distinct notices', 'See 1 notice in Service alerts'],
	['fr', '1 avis distinct', '2 avis distincts', 'Voir 1 avis dans les avis de service'],
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
	['en', ['16:38', '00:48'], '00:48, next day', 'Unknown time'],
	[
		'fr',
		['16\u00a0h\u00a038', '0\u00a0h\u00a048'],
		'0\u00a0h\u00a048, le lendemain',
		'Heure inconnue',
	],
] as const)(
	'displays service clocks and absence in %s',
	(locale, [late, early], nextDay, unknown) => {
		expect(serviceTime('16:38:52', locale)).toBe(late);
		expect(serviceTime('24:48:00', locale)).toBe(nextDay);
		expect(serviceTime('00:48:00', locale)).toBe(early);
		expect(serviceTime('24:60:00', locale)).toBeNull();
		expect(serviceTime(null, locale)).toBeNull();
		expect(scheduledClock(null, locale)).toBe(unknown);
	},
);

it.each(['en', 'fr'] as const)(
	'renders instants in the selected city across DST in %s',
	(locale) => {
		const time = (iso: string, zone = 'America/Los_Angeles') =>
			clockTime(new Date(iso), locale, zone);
		// Québec French writes the hour without a leading zero and an h: "1 h 59", "3 h".
		const clock = (en: string, fr: string) => (locale === 'fr' ? fr : en);
		expect(time('2026-03-08T09:59:59Z')).toBe(clock('01:59', '1\u00a0h\u00a059'));
		expect(time('2026-03-08T10:00:00Z')).toBe(clock('03:00', '3\u00a0h'));
		expect(time('2026-11-01T08:48:00Z')).toBe(clock('01:48', '1\u00a0h\u00a048'));
		expect(time('2026-11-01T09:48:00Z')).toBe(clock('01:48', '1\u00a0h\u00a048'));
		expect(time('2026-11-01T09:48:00Z', 'America/Toronto')).toBe(
			clock('04:48', '4\u00a0h\u00a048'),
		);
		expect(time('2026-11-01T07:00:00Z')).toBe(clock('00:00', '0\u00a0h'));
		expect(dateAndClock('2026-11-01T09:48:00Z', locale, 'America/Los_Angeles', true)).toContain(
			clock('01:48', '1\u00a0h\u00a048'),
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
	expect(clockRange(start, end, locale, zone)).toBe(
		from + (locale === 'fr' ? '–23\u00a0h\u00a045' : '–23:45'),
	);
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

const plain = (text: string | null) => text?.replace(/[\u00a0\u202f]/gu, ' ') ?? null;

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

it.each([
	[
		'en',
		'Sud to Nord, late 7.2%, 526 of 578 trips ran, 10,284 stop events',
		'7 of 7 days',
		'3 cancelled, 1 missing',
		'8,630 stops',
	],
	[
		'fr',
		'Sud to Nord, en retard 7,2 %, 526 sur 578 trajets effectués, 10 284 passages aux arrêts',
		'7 sur 7 jours',
		'3 annulés, 1 manquant',
		'8 630 arrêts',
	],
] as const)(
	'writes the phone row sentence without labels or trailing separators in %s',
	(locale, line, days, delivery, count) => {
		expect(
			plain(
				rowSentence(
					[
						'Sud to Nord',
						locale === 'fr' ? 'en retard 7,2 %' : 'late 7.2%',
						tripsRan(526, 578, locale),
						countedUnit(10284, 'event', locale),
						null,
						false,
					],
					locale,
				),
			),
		).toBe(line);
		expect(rowSentence([null, undefined], locale)).toBeNull();
		expect(daysInService(7, 7, locale)).toBe(days);
		expect(deliveryFacts(3, 1, locale)).toBe(delivery);
		const labels = countLabels(
			8630,
			locale === 'fr'
				? { singular: '{count} arrêt', plural: '{count} arrêts' }
				: { singular: '{count} stop', plural: '{count} stops' },
			locale,
		);
		expect(plain(labels.plural)).toBe(count);
	},
);

it('says once that every departure or hour is too few to judge, with the count and the minimum', () => {
	expect(tooFewDepartures(5, 20, 'en')).toBe(
		'Each departure has at most 5 scheduled trips; the minimum is 20.',
	);
	expect(tooFewDepartures(1, null, 'fr')).toBe('Chaque départ compte au plus 1 trajet prévu.');
	expect(tooFewHours(12, 25, 'en')).toBe(
		'Every hour has too few stop events to judge: at most 12; the minimum is 25.',
	);
	expect(tooFewHours(12, 25, 'fr')).toBe(
		'Chaque heure compte trop peu de passages aux arrêts pour conclure\u00a0: au plus 12, sur un minimum de 25.',
	);
});

it.each([
	['en', ['04:48', '07:00', '07:00 to 08:00']],
	['fr', ['4 h 48', '7 h', '7 h à 8 h']],
] as const)('writes clock times as %s readers do', (locale, [clock, hour, range]) => {
	expect(readerClock(4, 48, locale)).toBe(clock);
	expect(readerClock(7, 0, locale)).toBe(hour);
	expect(scheduleHours(7, 8, locale)).toBe(range);
	expect(scheduledClock('04:48:00', locale)).toBe(clock);
});

it.each([
	[
		'en',
		'Toward Station Laurier (Est)',
		'Toward the stop du Square-Victoria / Saint-Antoine (Est)',
	],
	['fr', 'Vers Station Laurier (est)', 'Vers l’arrêt du Square-Victoria / Saint-Antoine (est)'],
] as const)('names a terminus as riders do in %s', (locale, laurier, particle) => {
	expect(terminusName('Station Laurier (Saint-Joseph / Berri)')).toBe('Station Laurier');
	expect(terminusName('Station Laurier (Est)')).toBe('Station Laurier (Est)');
	const pattern = {
		termini: {
			est: 'Station Laurier (Saint-Joseph / Berri)',
			ouest: 'du Square-Victoria / Saint-Antoine',
		},
	};
	expect(towardReading(riderHeadsign('Est', pattern)!, locale)).toBe(laurier);
	expect(towardReading('du Square-Victoria / Saint-Antoine (Est)', locale)).toBe(particle);
	expect(towardReading('du Square-Victoria / Saint-Antoine (Est)', locale)).not.toMatch(
		/Vers du|Toward du/,
	);
});

it.each([
	['en', 'Gare Montréal-Ouest to Station Laurier', 'Angrignon to Honoré-Beaugrand'],
	['fr', 'De Gare Montréal-Ouest à Station Laurier', 'D’Angrignon à Honoré-Beaugrand'],
] as const)('reads a line from one terminus to the other in %s', (locale, bus, vowel) => {
	const ends = [
		'Gare Montréal-Ouest (Elmhurst / Sherbrooke)',
		'Station Laurier (Saint-Joseph / Berri)',
	];
	expect(lineSubtitle(3, ends, locale)).toBe(bus);
	expect(lineSubtitle(3, ['Angrignon', 'Honoré-Beaugrand'], locale)).toBe(vowel);
});

it.each([
	['en', 'Maple Lane / Springfield to Greenboro C', 'Toward the stop de l’Église'],
	['fr', 'De Maple Lane / Springfield à Greenboro C', 'Vers l’arrêt de l’Église'],
] as const)('reads termini written in capitals in title case in %s', (locale, line, toward) => {
	expect(lineSubtitle(3, ['MAPLE LANE / SPRINGFIELD', 'GREENBORO C'], locale)).toBe(line);
	expect(towardReading('DE L’ÉGLISE', locale)).toBe(toward);
	// A street that starts like a particle is not one.
	expect(lineSubtitle(3, ['DUFFERIN', 'DESJARDINS'], locale)).not.toMatch(/stop|arrêt/);
});

it('gives each agency its French article from the city’s declared form', () => {
	const stm = frenchAgency(
		agencyName('STM', { download_licence: { source: { fr: 'de la STM' } } }),
	);
	expect(stm).toEqual({
		subject: 'la STM',
		of: 'de la STM',
		by: 'par la STM',
		with: 'avec la STM',
		start: 'La STM',
	});
	const oc = frenchAgency(
		agencyName('OC Transpo', { download_licence: { source: { fr: 'd’OC Transpo' } } }),
	);
	expect(oc).toMatchObject({ subject: 'OC Transpo', by: 'par OC Transpo', start: 'OC Transpo' });
	// A city that declares no form keeps its bare name; no article is guessed.
	expect(frenchAgency(agencyName('STO', null))).toMatchObject({ subject: 'STO', of: 'de STO' });
});

it.each([
	[
		'en',
		['0 trips in 7 hours', '1 trip in 1 hour'],
		'0 stop events',
		'every minute',
		'notices are in effect now.',
	],
	[
		'fr',
		['0 trajet en 7 heures', '1 trajet en 1 heure'],
		'aucun passage aux arrêts',
		'chaque minute',
		'avis est en vigueur.',
	],
] as const)(
	'counts 0 and 1 as %s does',
	(locale, [noTrip, oneTrip], noEvent, everyMinute, noAlert) => {
		expect(tripsInHours(0, 7, locale)).toBe(noTrip);
		expect(tripsInHours(1, 1, locale)).toBe(oneTrip);
		expect(countedUnit(0, 'event', locale)).toBe(noEvent);
		expect(plannedInterval(60, locale)).toBe(everyMinute);
		expect(alertAnswerSentence(0, locale, true)).toBe(noAlert);
	},
);

it.each([
	['en', 'now', 'in 3 min'],
	['fr', 'maintenant', 'dans 3 min'],
] as const)('says a vehicle due within the minute is due now in %s', (locale, now, soon) => {
	expect(predictedIn(30_000, 0, locale)).toBe(soon.replace('3', '1'));
	expect(predictedIn(0, 0, locale)).toBe(now);
	expect(predictedIn(180_000, 0, locale)).toBe(soon);
});
