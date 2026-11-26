import { describe, expect, it } from 'vitest';
import {
	lineRecordHeading,
	lineSubtitle,
	plannedInterval,
	scheduleHours,
	towardReading,
	riderHeadsign,
} from '#lib/site/presenter.ts';
import { linePatterns } from '#lib/site/linePatterns.ts';
import type { RecordSeries } from '#lib/server/engine.ts';
import type { NameSeparators } from '#lib/v1/schemas/providers.ts';
import { measure } from '#lib/features/home/overviewRecord.fixture.ts';
import { delayBuilds, deliveryFinding } from './lineRecordText.ts';

describe('Line Record readings', () => {
	it('reads both endpoints in the chosen language when the provider declares separators', () => {
		const ends = ['Barrhaven Centre ~ Centre Barrhaven', 'Tunney’s Pasture ~ Pré Tunney'];
		const rule: NameSeparators = { ends: '<>', languages: '~', language_order: ['en', 'fr'] };
		expect(lineSubtitle(3, ends, 'en', rule)).toBe('Barrhaven Centre to Tunney’s Pasture');
		expect(lineSubtitle(3, ends, 'fr', rule)).toBe('Centre Barrhaven à Pré Tunney');
	});
	it.each([
		[
			'en',
			'Gare Montréal-Ouest to Station Laurier',
			'Toward Station Laurier (Est)',
			'Toward the east',
		],
		['fr', 'Gare Montréal-Ouest à Station Laurier', 'Vers Station Laurier (est)', 'Vers l’est'],
	] as const)(
		'uses scheduled termini for compass directions in %s',
		(locale, route, destination, fallback) => {
			const stops = ['Gare Montréal-Ouest', 'Queen-Mary / Décarie', 'Station Laurier'];
			const facts = linePatterns({
				date: '2026-11-26',
				routes: [],
				stops: stops.map((name, id) => ({ id: String(id), name, lat: 45, lon: -73 })),
				route_directions: {
					51: [
						{
							dir: 0,
							headsign: 'Est',
							stops: [
								{ id: '2', seq: 3 },
								{ id: '0', seq: 1 },
								{ id: '1', seq: 2 },
							],
						},
						{
							dir: 1,
							headsign: 'Ouest',
							stops: [
								{ id: '2', seq: 1 },
								{ id: '0', seq: 2 },
							],
						},
					],
				},
			})['51'];
			expect(lineSubtitle(3, facts.ends, locale)).toBe(route);
			expect(towardReading(riderHeadsign('Est', facts)!, locale)).toBe(destination);
			expect(towardReading('Est', locale)).toBe(fallback);
			expect(riderHeadsign('Billings Bridge', facts)).toBe('Billings Bridge');
		},
	);
	it.each([
		['en', 'Métro · Côte-Vertu to Montmorency', 'every 8 min', '07:00 to 09:00'],
		['fr', 'Métro · Côte-Vertu à Montmorency', 'toutes les 8 min', '07:00 à 09:00'],
	] as const)('formats route ends and the timetable in %s', (locale, route, interval, hours) => {
		const heading = lineRecordHeading(
			{ number: '51', name: 'Édouard-Montpetit', label: '51 · Édouard-Montpetit' },
			locale,
		);
		expect(heading).toBe(
			locale === 'en' ? 'Line 51 Édouard-Montpetit' : 'Ligne 51 Édouard-Montpetit',
		);
		expect(lineSubtitle(1, ['Côte-Vertu', 'Montmorency'], locale)).toBe(route);
		expect(plannedInterval(8, locale)).toBe(interval);
		expect(scheduleHours(7, 9, locale)).toBe(hours);
	});

	it('uses the numeric plate with a name and keeps a plain name for a nonnumeric plate', () => {
		const train = { number: '1', name: 'Confederation', label: '1 · Confederation' };
		expect(lineRecordHeading(train, 'en')).toBe('Line 1 Confederation');
		expect(lineRecordHeading(train, 'fr')).toBe('Ligne 1 Confederation');
		expect(lineRecordHeading({ ...train, number: 'O1' }, 'en')).toBe('Confederation');
		expect(lineRecordHeading({ number: '1', name: null, label: '1' }, 'en')).toBe('1');
	});

	it('totals complete departure counts and leaves incomplete evidence without a headline figure', () => {
		const cell = (
			scheduled: number,
			cancelled: number,
			missing: number | null,
		): RecordSeries['cells'][number] => ({
			key: { departure: '07:00:00' },
			state: 'measured',
			state_text: { en: 'Measured', fr: 'Mesuré' },
			value: {},
			evidence: { counts: { scheduled, cancelled, missing }, days_included: [] },
		});
		const answer: RecordSeries = {
			cells: [cell(800, 5, 12), cell(777, 7, 20)],
			evidence: { ...measure().evidence, days_not_measured: [] },
			coverage_note: null,
		};
		expect(deliveryFinding(answer, 'en')).toBe(
			'44 of 1,577 scheduled trips did not run: 12 cancelled by the agency and 32 missing, with no vehicle and no notice.',
		);
		expect(deliveryFinding(answer, 'fr')).toMatch(
			/44 des 1\s577 trajets prévus.*12 annulés.*32 manquants/u,
		);
		expect(
			deliveryFinding({ ...answer, cells: [...answer.cells, cell(5, 0, null)] }, 'en'),
		).toBeNull();
	});

	it('highlights an increase only between unambiguous adjacent stops in the same direction', () => {
		const cell = (
			stop: string,
			stop_sequence: number,
			median_delay: number,
			direction = 0,
		): RecordSeries['cells'][number] => ({
			key: { stop, stop_sequence, direction },
			state: 'measured',
			state_text: { en: 'Measured', fr: 'Mesuré' },
			value: { median_delay },
			evidence: { counts: {}, days_included: [] },
		});
		const cells = [
			cell('a', 1, 0),
			cell('b', 2, 60),
			cell('c', 3, 600),
			cell('branch', 3, 10),
			cell('d', 4, 900),
			cell('e', 5, 1200, 1),
			{ ...cell('f', 7, 2400, 1), state: 'unknown' as const },
		];
		expect(delayBuilds(cells)).toEqual({ from: 0, to: 1, seconds: 60 });
		expect(delayBuilds([cell('a', 1, 0), cell('b', 5, 60), cell('c', 8, 150)])).toEqual({
			from: 0,
			to: 2,
			seconds: 150,
		});
		expect(delayBuilds([cell('a', 1, 60), cell('b', 2, 0)])).toBeUndefined();
	});
});
