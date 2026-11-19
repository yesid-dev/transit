import { describe, expect, it } from 'vitest';
import { formatDateKey } from '#lib/utils/time.ts';
import { endOnDate } from './historyCopy';
import { copy as hotspots } from '#lib/features/hotspots/hotspots.copy.ts';
import { copy as offenders } from '#lib/features/repeat-offenders/repeatOffenders.copy.ts';
import { reliabilityCopy } from '#lib/features/lines/reliability/reliability.copy.ts';
import { stopReliabilityCopy } from '#lib/features/stops/reliability/stops-reliability.copy.ts';

// The 17th of every month of 2026, as the history captions print it.
const DAYS = Array.from({ length: 12 }, (_, m) => `2026-${String(m + 1).padStart(2, '0')}-17`);

describe('endOnDate', () => {
	it('adds the sentence period unless the date already ends with one', () => {
		expect(endOnDate('17 nov.')).toBe('17 nov.');
		expect(endOnDate('17 mai')).toBe('17 mai.');
		expect(endOnDate('Nov 17')).toBe('Nov 17.');
	});
});

describe('history captions ending on a date', () => {
	for (const locale of ['en', 'fr'] as const) {
		const captions: Array<[string, (day: string) => string]> = [
			['hotspots coverage', (day) => hotspots[locale].history.coverage(day, day)],
			['hotspots selection', (day) => hotspots[locale].history.selection(day)],
			['repeat offenders coverage', (day) => offenders[locale].history.coverage(day, day)],
			['repeat offenders selection', (day) => offenders[locale].history.selection(day)],
			['line coverage', (day) => reliabilityCopy[locale].history.coverage(day, day)],
			['line selection', (day) => reliabilityCopy[locale].history.selection(day, day)],
			['stop coverage', (day) => stopReliabilityCopy[locale].history.coverage(day, day)],
			['stop selection', (day) => stopReliabilityCopy[locale].history.selection(day, day)],
		];
		for (const [name, caption] of captions)
			it(`${locale} ${name} ends with exactly one period for every month`, () => {
				for (const key of DAYS) {
					const day = formatDateKey(key, locale);
					const text = caption(day);
					expect(text, day).toContain(day);
					expect(text, day).toMatch(/[^.]\.$/);
				}
			});
	}

	it('keeps the abbreviation period of a French month as the sentence end', () => {
		expect(hotspots.fr.history.selection(formatDateKey('2026-11-17', 'fr'))).toBe(
			'Date affichée : 17 nov.',
		);
		expect(offenders.fr.history.selection(formatDateKey('2026-05-17', 'fr'))).toBe(
			'Date affichée : 17 mai.',
		);
	});
});
