import { expect, it } from 'vitest';
import { routeNameFallback } from './absence.ts';
import { createLineDirectory } from './lineDirectory.ts';
import {
	clockRange,
	clockTime,
	dateAndClock,
	dateRange,
	delayReading,
	directionLabel,
	fileSize,
	longDate,
	methodEvidence,
	minuteReading,
	registryUnitText,
	scheduledClock,
	serviceTime,
	tripsInHours,
	versionNumber,
} from './presenter.ts';

const normalize = (text: string | null) => text?.replaceAll('\u00a0', ' ');

it.each([
	['en', '13 October 2026'],
	['fr', '13 octobre 2026'],
] as const)('writes the full day-first date in %s', (locale, expected) => {
	expect(longDate('2026-10-13', locale)).toBe(expected);
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
