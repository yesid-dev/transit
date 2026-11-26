import type { Locale } from '#lib/i18n/index.ts';
import { describe, expect, it } from 'vitest';
import {
	lineExclusion,
	lineMatches,
	lineQuery,
	lineSort,
	orderedLines,
	lineSpread,
	observedLineReadings,
} from './linesRecord.ts';

describe('Lines Record', () => {
	it('finds a line by its number or its name, ignoring accents and case', () => {
		const lines = [
			{ number: '24', label: 'Sherbrooke' },
			{ number: '51', label: 'Édouard-Montpetit' },
			{ number: '105', label: 'Sherbrooke-Ouest' },
		];
		const find = (query: string) =>
			lines.filter((line) => lineMatches(line, query)).map(({ number }) => number);
		expect(find('24')).toEqual(['24']);
		expect(find('51')).toEqual(['51']);
		expect(find('sherbrooke')).toEqual(['24', '105']);
		expect(find('edouard montpetit')).toEqual(['51']);
		expect(find('24 sherb')).toEqual(['24']);
		expect(find('')).toEqual(['24', '51', '105']);
		expect(find(' - ')).toEqual(['24', '51', '105']);
		expect(find('Laurier')).toEqual([]);
		expect(lineQuery(new URLSearchParams('q=%20%2051%20'))).toBe('51');
		expect(lineQuery(new URLSearchParams(''))).toBe('');
	});
	const rows = [
		{ id: '2', number: '2', onTime: 0.847, late: 0.1, trips: null },
		{ id: '10', number: '10', onTime: 0.732, late: 0.2, trips: 0.98 },
		{ id: '20', number: '20', onTime: 0.732, late: 0.15, trips: 0.95 },
	];
	it('reads and validates a shareable sort, with numeric line numbers and absent readings last', () => {
		expect(lineSort(new URLSearchParams('sort=unknown&direction=desc'))).toEqual({
			key: 'line',
			direction: 'asc',
		});
		const sort = lineSort(new URLSearchParams('sort=trips&direction=desc'));
		expect(orderedLines(rows, sort, 'en').map(({ id }) => id)).toEqual(['10', '20', '2']);
		expect(
			orderedLines(rows, { key: 'line', direction: 'desc' }, 'fr').map(({ id }) => id),
		).toEqual(['20', '10', '2']);
		expect(
			orderedLines(rows, { key: 'onTime', direction: 'asc' }, 'en').map(({ id }) => id),
		).toEqual(['10', '20', '2']);
	});

	it.each([
		['line', 'asc'],
		['onTime', 'asc'],
		['late', 'desc'],
		['trips', 'asc'],
	])('uses the natural direction for %s unless the URL supplies one', (key, direction) => {
		expect(lineSort(new URLSearchParams({ sort: key }))).toEqual({ key, direction });
	});

	it('pools observed shares by scheduled stop events and ignores missing readings', () => {
		expect(
			observedLineReadings([
				{ share_observed: 0.4, counts: { scheduled: 250 } },
				{ share_observed: 1, counts: { punctuality_scheduled: 50 } },
				{ counts: { scheduled: 1000 } },
			]),
		).toEqual({ share: 0.5, scheduled: 300 });
		expect(observedLineReadings([{ share_observed: 0, counts: { scheduled: 20 } }])).toEqual({
			share: 0,
			scheduled: 20,
		});
		expect(observedLineReadings([{ counts: { scheduled: 20 } }])).toBeNull();
	});

	it.each([
		['en', '73.2% to 84.7%'],
		['fr', '73,2\u00a0% à 84,7\u00a0%'],
	] as const)(
		'presents the spread in %s and leaves an empty answer blank',
		(locale: Locale, value) => {
			expect(lineSpread(rows, locale)).toBe(value);
			expect(lineSpread([], locale)).toBeNull();
		},
	);
});

describe('lines that cannot be judged', () => {
	it('names a timetable line without an engine cell as having no trip on these dates', () => {
		// STM 18 to 24 Nov 2026: 26E, 51E and 767 have no cell in the line answer.
		expect(lineExclusion(undefined)).toEqual({
			state: 'not_measured',
			text: { en: 'No trip scheduled on these dates.', fr: 'Aucun trajet prévu à ces dates.' },
		});
	});

	it('never leaves a bare Unknown without its reason', () => {
		const unknown = lineExclusion({ state: 'unknown', evidence: { counts: { classified: 0 } } });
		expect(unknown.state).toBe('unknown');
		expect(unknown.text?.en).toBe('No stop event of this line had a reading on these dates.');
		expect(
			lineExclusion({ state: 'too_few_to_judge', evidence: { counts: { classified: 40 } } }),
		).toEqual({ state: 'too_few_to_judge', text: null });
	});
});
