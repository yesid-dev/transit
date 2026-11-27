import type { Locale } from '#lib/i18n/index.ts';
import { describe, expect, it } from 'vitest';
import {
	lineExclusion,
	lineHold,
	lineHoldText,
	lineMatches,
	lineQuery,
	lineSort,
	lineSortKeys,
	orderedLines,
	lineSpread,
	observedLineReadings,
} from './linesRecord.ts';

describe('Lines Record', () => {
	const floors = { classified: 100, observed_trips: 20 };
	const timing = (counts: Record<string, number | null>, low_coverage?: boolean) => ({
		evidence: { counts, low_coverage },
	});

	it('holds a line out of the headline as Rankings does: floors first, then low coverage', () => {
		// OC Transpo line 301, 19 to 25 Nov: 104 stop events but 2 observed trips.
		const thin = lineHold(timing({ classified: 104, observed_trips: 2 }), floors);
		expect(thin).toEqual({
			reason: 'too_few_to_judge',
			unit: 'trip-observed',
			count: 2,
			minimum: 20,
		});
		expect(lineHoldText(thin!, 'en')).toBe('2 observed trips. A line needs 20 to be ranked.');
		expect(lineHoldText(thin!, 'fr')).toBe(
			'2 trajets observés. Il en faut 20 pour classer une ligne.',
		);
		// STM line 222: 66 stop events.
		expect(lineHold(timing({ classified: 66, observed_trips: 40 }), floors)).toMatchObject({
			unit: 'event',
			count: 66,
		});
		// STM line 872: enough events, 33.1% observed.
		const low = lineHold(timing({ classified: 400, observed_trips: 60 }, true), floors);
		expect(low).toEqual({ reason: 'low_coverage' });
		expect(lineHoldText(low!, 'fr')).toBe('Faible couverture');
		expect(lineHold(timing({ classified: 21_693, observed_trips: 527 }), floors)).toBeNull();
	});

	it('applies only the floors the answer carries a count for', () => {
		expect(lineHold(timing({ classified: 104 }), floors)).toBeNull();
		expect(lineHold(timing({ classified: 104, observed_trips: 2 }), undefined)).toBeNull();
		expect(lineHold(undefined, floors)).toBeNull();
	});

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
	it('puts held lines after ranked lines regardless of the selected order', () => {
		const held = {
			...rows[0]!,
			hold: lineHold(timing({ classified: 104, observed_trips: 2 }), floors),
		};
		for (const key of lineSortKeys)
			for (const direction of ['asc', 'desc'] as const)
				expect(orderedLines([held, ...rows.slice(1)], { key, direction }, 'en').at(-1)).toBe(held);
	});

	it('sorts measured low-coverage rows by their share', () => {
		const low = {
			...rows[0]!,
			onTime: 0.6,
			hold: lineHold(timing({ classified: 120, observed_trips: 30 }, true), floors),
		};
		expect(
			orderedLines([low, ...rows.slice(1)], { key: 'onTime', direction: 'asc' }, 'en')[0],
		).toBe(low);
	});
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
