import { dateRange } from '#lib/site/presenter.ts';
import { describe, expect, it } from 'vitest';
import type { EngineResult, MeasureAnswer } from '#lib/server/engine.ts';
import { delivered, measure, period, stateText } from './overviewRecord.fixture.ts';
import {
	citationText,
	comparisonText,
	measureText,
	overviewValue,
	previewRows,
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
			'8 to 14 Nov 2026, 81.2% of recorded stop arrivals were on time (412,355 of 507,800) · 60.0% of 846,333 scheduled stops observed.',
		);
		expect(measureText(answer(measure()), period, 'fr').replace(/\s/g, ' ')).toBe(
			'du 8 au 14 nov. 2026, 81,2 % des passages enregistrés aux arrêts étaient à l’heure (412 355 sur 507 800) · 60,0 % des 846 333 passages prévus observés.',
		);
	});

	it('compares with the immediately preceding inclusive period across a year boundary', () => {
		const previous = previousPeriod({ from: '2027-01-01', to: '2027-01-07' });
		expect(previous).toEqual({ from: '2026-12-25', to: '2026-12-31' });
		expect(dateRange({ from: '2026-12-31', to: '2027-01-01' }, 'en')).toBe(
			'31 Dec 2026 to 1 Jan 2027',
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
		expect(comparisonText(answer(measure()), answer(baseline), 'en')).toBe('1.2 points higher');
		expect(comparisonText(answer(measure()), answer(baseline), 'fr')).toBe('1,2 point de plus');
		const almostSame = {
			...current,
			evidence: { ...current.evidence, counts: { ...current.evidence.counts, on_time: 412400 } },
		};
		expect(comparisonText(answer(current), answer(almostSame), 'en')).toBe(
			'About the same (within normal variation)',
		);
		expect(comparisonText(answer(measure()), answer(measure('not_measured')), 'fr')).toBeNull();
		expect(comparisonText(answer(current), answer(current), 'en')).toBe(
			'About the same (within normal variation)',
		);
		expect(comparisonText(answer(current), answer(current), 'fr')).toBe(
			'À peu près pareil (variation normale)',
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
			'90.0% of scheduled trips with a known outcome ran (90 of 100). Method v1, cleaning v6.',
		);
	});

	it.each(gaps)('uses the engine’s %s words without substituting a zero', (state) => {
		expect(
			overviewValue(answer({ ...measure(state), value: { on_time: 0 } }), 'on_time'),
		).toBeNull();
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
		expect(overviewValue(answer(value), 'on_time')).toBe(0);
		expect(measureText(answer(value), period, 'en')).toContain(
			'0.0% of recorded stop arrivals were on time (0 of 507,800) · 60.0% of 846,333 scheduled stops observed.',
		);
	});
});

describe('preview rows', () => {
	it('sorts the three rows by the share shown, as the Daily report of 24 Nov showed them', () => {
		// Stops ranked by the cautious bound: 28.6%, 28.0%, 30.2%.
		const stops = [
			{ id: '58989', rank: 1, value: 0.286 },
			{ id: '53015', rank: 2, value: 0.28 },
			{ id: '61263', rank: 3, value: 0.302 },
		];
		expect(previewRows(stops).map((row) => row.value)).toEqual([0.28, 0.286, 0.302]);
	});

	it('never shows a low-coverage row, even from an engine that still ranks it', () => {
		const lines = [
			{ id: '74', rank: 1, value: 0.498, low_coverage: true },
			{ id: '445', rank: 2, value: 0.606 },
			{ id: '69', rank: 3, value: 0.64 },
			{ id: '18', rank: 4, value: 0.65 },
		];
		expect(previewRows(lines).map((row) => row.id)).toEqual(['445', '69', '18']);
	});
});
