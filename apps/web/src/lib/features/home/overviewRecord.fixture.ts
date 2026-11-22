import type { MeasureAnswer, RankingAnswer } from '#lib/server/engine.ts';

export const period = { from: '2026-11-08', to: '2026-11-14' };
export const stateText = {
	measured: { en: 'Measured', fr: 'Mesuré' },
	not_measured: { en: 'Not measured', fr: 'Non mesuré' },
	too_few_to_judge: { en: 'Too few to judge', fr: 'Trop peu de données pour conclure' },
	no_live_data: { en: 'No live data', fr: 'Aucune donnée en direct' },
	not_tracked: { en: 'Not tracked', fr: 'Non suivi' },
	unknown: { en: 'Unknown', fr: 'Inconnu' },
};

const evidence = {
	start_date: period.from,
	end_date: period.to,
	days_measured: [period.from],
	days_included: [period.from],
	days_not_measured: [period.to],
	cleaning_versions: [6],
	method_version: 'punctuality-v2',
	query_ms: 12,
};

export function measure(state: MeasureAnswer['state'] = 'measured'): MeasureAnswer {
	return {
		measure: 'on_time',
		state,
		state_text: stateText[state],
		value: { on_time: state === 'measured' ? 412355 / 507800 : null },
		coverage_note: {
			en: 'Only measured days are included.',
			fr: 'Seuls les jours mesurés sont inclus.',
		},
		evidence: { ...evidence, counts: { on_time: 412355, classified: 507800 }, excluded: {} },
	};
}

export const delivered: MeasureAnswer = {
	...measure(),
	measure: 'trips_run',
	value: { trips_run: 0.9 },
	evidence: {
		...evidence,
		method_version: 'service-delivered-v1',
		counts: { ran: 90, eligible: 100, scheduled: 111 },
		excluded: { unconfirmed: 11 },
	},
};

export const ranking: RankingAnswer = {
	measure: 'on_time',
	kind: 'line',
	class: '3:frequent',
	rows: [
		{
			id: '24',
			rank: 1,
			sample: 1000,
			value: 0.4,
			range: { lower: 0.37, upper: 0.43, method: 'wilson_95' },
		},
	],
	excluded: [],
	info: [{ minimum_sample: 30 }],
	coverage_note: null,
	evidence,
};
