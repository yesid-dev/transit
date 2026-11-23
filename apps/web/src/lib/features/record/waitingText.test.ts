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
		'40.3 s · 20 observed intervals, 14 scheduled intervals in comparable windows',
	);
	expect(waitingReading(measured, 'long_gaps', 'en')).toBe('0% (0 of 20)');
	expect(waitingReading(measured, 'bunching', 'fr')).toMatch(/20\s% \(4 sur 20\)/);
	expect(coverageText(measured.evidence, 'en')).toBe(
		'40% coverage of 50 scheduled intervals in frequent periods · Low coverage',
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
	).toBe('Not measured (insufficient coverage)');
});
