import { expect, it } from 'vitest';
import type { RecordCell } from '#lib/server/engine.ts';
import { coverageText } from './recordText.ts';
import { waitingReading } from './waitingText.ts';

const measured: RecordCell = {
	state: 'measured',
	state_text: { en: 'Measured', fr: 'Mesuré' },
	value: { excess_wait_time: 40.25, long_gaps: 0, bunching: 0.2 },
	evidence: {
		days_included: ['2026-11-16'],
		share_observed: 0.4,
		low_coverage: true,
		counts: {
			observed_headways: 20,
			frequent_headways: 50,
			covered_scheduled_headways: 14,
			long_gaps: 0,
			bunching: 4,
		},
	},
};

it('reads a pooled wait with its matched basis and a disruption share with its observed sample', () => {
	expect(waitingReading(measured, 'excess_wait_time', 'en')).toBe(
		'0.7 min · 20 gaps between vehicles seen, compared with 14 planned gaps in those periods (28.0% of all gaps planned at that frequency), when vehicles are due every 10 minutes or less',
	);
	expect(waitingReading(measured, 'long_gaps', 'en')).toBe('0.0% (0 of 20)');
	expect(waitingReading(measured, 'bunching', 'fr')).toMatch(/20,0\s% \(4 sur 20\)/);
	expect(coverageText(measured.evidence, 'en')).toBe(
		'40.0% of 50 planned gaps between vehicles seen, when vehicles are due every 10 minutes or less · Low coverage',
	);
});

it.each([
	[
		'en',
		'0.6 min · 36,474 gaps between vehicles seen, compared with 29,394 planned gaps in those periods (50.6% of all gaps planned at that frequency), when vehicles are due every 10 minutes or less',
	],
	[
		'fr',
		'0,6 min · 36 474 intervalles entre deux véhicules observés, comparés à 29 394 intervalles prévus durant ces périodes (50,6 % des intervalles prévus à cette fréquence), quand les véhicules passent aux 10 minutes ou moins',
	],
] as const)('compares observed and planned gaps on their own bases in %s', (locale, sentence) => {
	const line = {
		...measured,
		value: { excess_wait_time: 37.51566405237588 },
		evidence: {
			...measured.evidence,
			counts: {
				observed_headways: 36474,
				covered_scheduled_headways: 29394,
				frequent_headways: 58113,
			},
		},
	};
	expect(waitingReading(line, 'excess_wait_time', locale).replace(/[\u00a0\u202f]/gu, ' ')).toBe(
		sentence,
	);
});

it('keeps an unavailable wait and a coverage-gated reading distinct from an observed zero', () => {
	expect(
		waitingReading(
			{
				...measured,
				evidence: { ...measured.evidence, measure_states: { excess_wait_time: 'unknown' } },
			},
			'excess_wait_time',
			'fr',
		),
	).toBe('Inconnu');
	expect(
		waitingReading(
			{
				...measured,
				state: 'not_measured',
				state_text: { en: 'Not measured', fr: 'Non mesuré' },
				evidence: { ...measured.evidence, coverage_reason: 'insufficient_coverage' },
			},
			'long_gaps',
			'en',
		),
	).toBe('Not measured: too little observed');
});
