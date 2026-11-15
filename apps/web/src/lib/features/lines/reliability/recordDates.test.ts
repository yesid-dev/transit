import { describe, expect, it } from 'vitest';
import { formatRecordDates } from './recordDates';

describe('formatRecordDates', () => {
	it.each([
		['2026-11-04', '2026-11-10', 'en', false, 'November 4 to 10'],
		['2026-11-04', '2026-11-10', 'fr', false, 'du 4 au 10 novembre'],
		['2026-10-28', '2026-11-03', 'en', false, 'October 28 to November 3'],
		['2026-10-28', '2026-11-03', 'fr', false, 'du 28 octobre au 3 novembre'],
		['2026-11-10', '2026-11-10', 'en', false, 'Tuesday, November 10'],
		['2026-11-10', '2026-11-10', 'fr', false, 'mardi 10 novembre'],
		['2026-11-04', '2026-11-10', 'en', true, 'November 4 to 10, 2026'],
		['2026-11-04', '2026-11-10', 'fr', true, 'du 4 au 10 novembre 2026'],
		['2026-12-28', '2027-01-03', 'en', true, 'December 28, 2026 to January 3, 2027'],
		['2026-12-28', '2027-01-03', 'fr', true, 'du 28 décembre 2026 au 3 janvier 2027'],
		['2026-11-10', '2026-11-10', 'en', true, 'Tuesday, November 10, 2026'],
		['2026-11-10', '2026-11-10', 'fr', true, 'mardi 10 novembre 2026'],
	] as const)('%s to %s in %s (year %s): %s', (from, to, locale, year, expected) => {
		expect(formatRecordDates(from, to, locale, { year })).toBe(expected);
	});

	it('never shows a malformed date', () => {
		expect(formatRecordDates('2026-13-40', '2026-11-10', 'en')).toBeNull();
	});
});
