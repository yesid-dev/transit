import { expect, it } from 'vitest';
import { coverageText, rateStateText, timingBasis } from './recordText.ts';

it('shows the share and scheduled stop count alongside the low-coverage warning', () => {
	const evidence = { counts: { scheduled: 434854 }, share_observed: 0.567 };
	expect(coverageText(evidence, 'en')).toBe('56.7% of 434,854 scheduled stops observed');
	expect(
		coverageText({ ...evidence, share_observed: 0.4, low_coverage: true }, 'fr').replace(
			/\s/g,
			' ',
		),
	).toBe('40 % des 434 854 passages prévus observés · Faible couverture');
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
		'Not measured (insufficient coverage) · Status known for 20% of 400 scheduled trips on lines with live data · Low coverage',
	);
	expect(rateStateText(answer, 'fr')).toContain('Non mesuré (couverture insuffisante)');
});

it('shows all timing sources and warns only when most times are predictions', () => {
	expect(timingBasis({ vehicle_stopped: 50, trip_update_passed: 50 }, 'en')).toBe(
		'Observed times: 50% vehicle reported stopped, 50% last prediction before the vehicle passed.',
	);
	expect(timingBasis({ vehicle_nearby: 60, trip_update_passed: 40 }, 'en')).toBe(
		'Observed times: 60% vehicle GPS near the stop, 40% last prediction before the vehicle passed.',
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
		'Heures observées : 20 % véhicule signalé à l’arrêt, 20 % heure signalée par l’agence, 60 % dernière prévision avant le passage du véhicule. La plupart de ces heures proviennent de prévisions.',
	);
});
