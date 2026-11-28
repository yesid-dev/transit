import { expect, it } from 'vitest';
import { countedRecordDays, coverageText, rateStateText, timingBasis } from './recordText.ts';

it('distinguishes measured days from the full selected period in both languages', () => {
	const evidence = {
		start_date: '2026-10-01',
		end_date: '2026-11-14',
		days_included: Array.from({ length: 42 }, (_, index) =>
			new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10),
		),
	};
	expect(countedRecordDays(evidence, 'en')).toBe('42 of the 45 days');
	expect(countedRecordDays(evidence, 'fr')).toBe('42 des 45 jours');
	expect(countedRecordDays({ ...evidence, end_date: '2026-11-11' }, 'en')).toBe('42 days');
	expect(countedRecordDays({ ...evidence, days_included: [] }, 'en')).toBe('');
});

it('shows the share and scheduled stop count alongside the low-coverage warning', () => {
	const evidence = { counts: { scheduled: 434854 }, share_observed: 0.567 };
	expect(coverageText(evidence, 'en')).toBe('56.7% of 434,854 scheduled stops observed');
	expect(
		coverageText({ ...evidence, share_observed: 0.4, low_coverage: true }, 'fr').replace(
			/\s/g,
			' ',
		),
	).toBe('40,0 % des 434 854 passages prévus observés · Faible couverture');
});

it('keeps the reason for an engine-gated rate and its known coverage', () => {
	const answer = {
		state: 'not_measured',
		state_text: { en: 'Not measured', fr: 'Non mesuré' },
		evidence: {
			counts: { scheduled: 500, eligible: 80 },
			excluded: { route_without_live_data: 100 },
			share_eligible: 0.2,
			coverage_reason: 'insufficient_coverage',
			low_coverage: true,
		},
	} as const;
	expect(rateStateText(answer, 'en')).toBe(
		'Not measured: too little observed · Status known for 20.0% of 400 scheduled trips on lines with live data',
	);
	expect(rateStateText(answer, 'fr')).toContain('Non mesuré\u00a0: trop peu observé');
	// The two limits are said once each: a figure that is not measured is never also low coverage.
	expect(rateStateText(answer, 'en')).not.toContain('Low coverage');
	expect(rateStateText(answer, 'fr')).not.toContain('Faible couverture');
});

it('shows all timing sources and warns only when most times are predictions', () => {
	expect(timingBasis({ vehicle_stopped: 50, trip_update_passed: 50 }, 'en')).toBe(
		'Observed times: 50.0% vehicle reported stopped, 50.0% last prediction before the vehicle passed.',
	);
	expect(timingBasis({ vehicle_nearby: 60, trip_update_passed: 40 }, 'en')).toBe(
		'Observed times: 60.0% vehicle GPS near the stop, 40.0% last prediction before the vehicle passed.',
	);
	expect(
		timingBasis(
			{
				punctuality_vehicle_stopped: 2,
				punctuality_trip_update_reported: 2,
				punctuality_trip_update_passed: 6,
			},
			'fr',
		).replace(/\s/g, ' '),
	).toBe(
		'Heures observées : 20,0 % véhicule signalé à l’arrêt, 20,0 % heure signalée par la société de transport, 60,0 % dernière prévision avant le passage du véhicule. La plupart de ces heures proviennent de prévisions.',
	);
});
