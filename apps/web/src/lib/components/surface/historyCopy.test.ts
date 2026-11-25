import { describe, expect, it } from 'vitest';
import { formatDateKey } from '#lib/utils/time.ts';
import { endOnDate } from './historyCopy';
import { reliabilityCopy } from '#lib/features/lines/reliability/reliability.copy.ts';

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
			['line coverage', (day) => reliabilityCopy[locale].history.coverage(day, day)],
			['line selection', (day) => reliabilityCopy[locale].history.selection(day, day)],
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
		expect(endOnDate(formatDateKey('2026-11-17', 'fr'))).toBe('17 nov.');
	});
});
