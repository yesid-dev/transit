import type { Locale } from '#lib/i18n/index.ts';
import { describe, expect, it } from 'vitest';
import { lineSort, orderedLines, lineSpread } from './linesRecord.ts';

describe('Lines Record', () => {
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
