export function waitingEngine(url, evidence) {
	const definition = {
		excess_wait_time: [
			'Observed wait minus scheduled wait.',
			'Attente observée moins attente prévue.',
		],
		long_gaps: [
			'Share of intervals longer than twice the scheduled average.',
			'Part des intervalles dépassant le double de la moyenne prévue.',
		],
		bunching: [
			'Share of intervals shorter than half the scheduled average.',
			'Part des intervalles inférieurs à la moitié de la moyenne prévue.',
		],
	};
	const info = Object.entries(definition).map(([id, [en, fr]]) => ({
		id,
		minimum_sample: 20,
		minimum_coverage: 0.4,
		text: {
			en: { definition: en, counts: '', limits: '' },
			fr: { definition: fr, counts: '', limits: '' },
		},
	}));
	const value = { excess_wait_time: 45, long_gaps: 2 / 24, bunching: 6 / 24 };
	const coverage_note = null;
	const measured = {
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		value,
		evidence: {
			days_included: evidence.days_included,
			share_observed: 0.5,
			counts: {
				frequent_headways: 48,
				observed_headways: 24,
				covered_scheduled_headways: 20,
				long_gaps: 2,
				bunching: 6,
			},
		},
	};
	if (!url.searchParams.has('stop')) {
		return {
			body: { ...measured, info, coverage_note, evidence: { ...evidence, ...measured.evidence } },
		};
	}
	const lowCoverage = url.searchParams.get('from') === '2026-11-10';
	const cells = [
		{ ...measured, key: { line: '80' } },
		{
			key: { line: '24' },
			state: lowCoverage ? 'not_measured' : 'too_few_to_judge',
			state_text: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
			value: {},
			evidence: {
				days_included: evidence.days_included,
				counts: { observed_headways: 3, frequent_headways: lowCoverage ? 20 : 4 },
				share_observed: lowCoverage ? 0.15 : 0.75,
				...(lowCoverage ? { coverage_reason: 'insufficient_coverage', low_coverage: true } : {}),
			},
		},
		{
			key: { line: '999' },
			state: 'no_frequent_periods',
			state_text: { en: 'No frequent periods', fr: 'Aucune période fréquente' },
			value: {},
			evidence: { days_included: evidence.days_included, counts: { frequent_headways: 0 } },
		},
	];
	return { body: { cells, evidence, info, coverage_note } };
}
