import { describe, expect, it } from 'vitest';
import { averageDelay } from './offenderDelay';

// Expected text is written out, not derived from the formatter: one decimal, half away from zero.
const CASES = [
	[-8.44, { direction: 'early', en: '8.4 min', fr: '8,4 min' }],
	[-0.05, { direction: 'early', en: '0.1 min', fr: '0,1 min' }],
	[-0.04, { direction: 'onTime' }],
	[-0, { direction: 'onTime' }],
	[0, { direction: 'onTime' }],
	[0.04, { direction: 'onTime' }],
	[8.4, { direction: 'late', en: '8.4 min', fr: '8,4 min' }],
] as const;

describe('averageDelay', () => {
	for (const locale of ['en', 'fr'] as const)
		for (const [value, expected] of CASES)
			it(`reads ${Object.is(value, -0) ? '-0' : value} as ${expected.direction} in ${locale}`, () => {
				const delay = averageDelay(value, locale);
				expect(delay).toEqual(
					expected.direction === 'onTime'
						? { direction: 'onTime' }
						: { direction: expected.direction, minutes: expected[locale] },
				);
				// Never a sign: the direction carries it.
				if (delay?.direction !== 'onTime') expect(delay?.minutes).not.toMatch(/[-−]/);
			});

	it('stays absent when the average is not published', () => {
		expect(averageDelay(null, 'en')).toBeNull();
		expect(averageDelay(Number.NaN, 'fr')).toBeNull();
	});
});
