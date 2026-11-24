import { expect, it } from 'vitest';
import { ON_TIME_LIMITS_S } from '#lib/v1/live/statusBands.ts';
import { lineViewsCopy } from './lineViews.copy';

it.each([
	['en', 'inclusive', 'before rounding'],
	['fr', 'limites incluses', 'avant l’arrondi'],
] as const)(
	'explains the published inclusive band before rounding in %s',
	(locale, inclusive, rounding) => {
		const text = lineViewsCopy[locale].bands;
		expect([...text.matchAll(/\d+/g)].map(([minutes]) => Number(minutes))).toEqual([
			-ON_TIME_LIMITS_S.from / 60,
			ON_TIME_LIMITS_S.through / 60,
		]);
		expect(text).toContain(inclusive);
		expect(text).toContain(rounding);
	},
);
