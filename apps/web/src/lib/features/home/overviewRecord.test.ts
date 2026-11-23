import { describe, expect, it } from 'vitest';
import type { EngineResult, MeasureAnswer } from '#lib/server/engine.ts';
import { delivered, measure, period, stateText } from './overviewRecord.fixture.ts';
import {
	citationText,
	comparisonText,
	dateRange,
	measureText,
	previousPeriod,
} from './overviewRecord.ts';

const answer = (value: MeasureAnswer): EngineResult<MeasureAnswer> => ({
	kind: 'answer',
	answer: value,
});
const gaps = [
	'not_measured',
	'too_few_to_judge',
	'no_live_data',
	'not_tracked',
	'unknown',
] as const;

describe('Overview record text', () => {
	it('formats the answer and both counts in English and Québec French', () => {
		expect(measureText(answer(measure()), period, 'en')).toBe(
			'From November 8 to 14, 2026, 81.2% of observed stop events were on time (412,355 of 507,800) · 60% of 846,333 scheduled stops observed.',
		);
		expect(measureText(answer(measure()), period, 'fr').replace(/\s/g, ' ')).toBe(
			'Du 8 au 14 novembre 2026, 81,2 % des passages observés aux arrêts étaient à l’heure (412 355 sur 507 800) · 60 % des 846 333 passages prévus observés.',
		);
	});

	it('compares with the immediately preceding inclusive period across a year boundary', () => {
		const previous = previousPeriod({ from: '2027-01-01', to: '2027-01-07' });
		expect(previous).toEqual({ from: '2026-12-25', to: '2026-12-31' });
		expect(dateRange({ from: '2026-12-31', to: '2027-01-01' }, 'en')).toBe(
			'From December 31, 2026 to January 1, 2027',
		);
		const current = measure();
		const baseline = {
			...current,
			value: { on_time: 0.8 },
			evidence: { ...current.evidence, counts: { ...current.evidence.counts, on_time: 406240 } },
		};
		expect(previousPeriod({ from: '2027-01-04', to: '2027-01-04' })).toEqual({
			from: '2026-12-28',
			to: '2026-12-28',
		});
		expect(comparisonText(answer(measure()), answer(baseline), 'en')).toBe(
			'Change of +1.2 percentage points.',
		);
		expect(comparisonText(answer(measure()), answer(baseline), 'fr')).toBe(
			'Écart de +1,2 point de pourcentage.',
		);
		expect(comparisonText(answer(measure()), answer(measure('not_measured')), 'fr')).toBeNull();
		expect(comparisonText(answer(current), answer(current), 'en')).toBe(
			'About the same (within normal variation) [0.0 percentage points]',
		);
		expect(comparisonText(answer(current), answer(current), 'fr')).toBe(
			'Environ pareil (variation normale) [0,0 point de pourcentage]',
		);
		expect(
			comparisonText(
				answer(current),
				answer({ ...baseline, evidence: { ...baseline.evidence, days_measured: [period.from] } }),
				'en',
			),
		).toBeNull();
	});

	it('uses the eligible trip count and cites the versions', () => {
		expect(citationText(delivered, period, 'en')).toContain(
			'90% of scheduled trips with a known outcome ran (90 of 100). Method service-delivered-v1. Data cleaning version 6.',
		);
	});

	it.each(gaps)('uses the engine’s %s words without substituting a zero', (state) => {
		for (const locale of ['en', 'fr'] as const) {
			expect(measureText(answer(measure(state)), period, locale)).toBe(stateText[state][locale]);
		}
	});

	it('distinguishes the missing origin from an engine-reported gap', () => {
		const missing = { kind: 'unconfigured' } as const;
		expect(measureText(missing, period, 'en')).toMatch(/Numbers will appear here/);
		expect(measureText(missing, period, 'fr')).toMatch(/Les chiffres s’afficheront ici/);
	});

	it('keeps a measured zero with its denominator', () => {
		const value = measure();
		value.value.on_time = 0;
		value.evidence.counts.on_time = 0;
		expect(measureText(answer(value), period, 'en')).toContain(
			'0% of observed stop events were on time (0 of 507,800) · 60% of 846,333 scheduled stops observed.',
		);
	});
});
