import {
	getMeasure,
	getMethodCatalog,
	getRecordDataHealth,
	getRecordMeasure,
	getRecordSeries,
	getScorecardAnswer,
	type EnginePeriod,
} from './engine.ts';
import { readingFilter } from './readingFilter.ts';
import {
	agencyHealthQuestions,
	networkRecordQuestions,
	type AgencyScorecardMeasure,
} from './screenQuestions.ts';

/** Data health's readings in Record; with `only`, just the named readings, asked again. */
export function readHealthRecord(
	scope: EnginePeriod,
	alertsTracked: boolean,
	only?: ReadonlySet<string>,
) {
	const include = readingFilter(only);
	const questions = agencyHealthQuestions();
	return {
		coverage: include('coverage') ? getMeasure('punctuality', scope) : undefined,
		accessibility: include('accessibility')
			? getRecordMeasure(questions.accessibility, scope)
			: undefined,
		alertEffects:
			alertsTracked && include('alertEffects')
				? getRecordSeries(questions.alertEffects, scope)
				: null,
		deliveryDays: include('deliveryDays')
			? getRecordSeries(networkRecordQuestions.deliveryDays, scope)
			: undefined,
		scorecard: Object.fromEntries(
			questions.scorecard
				.filter(({ measure }) => include(measure))
				.map(({ measure, query }) => [measure, getScorecardAnswer(query, scope)]),
		) as Record<AgencyScorecardMeasure, ReturnType<typeof getScorecardAnswer>>,
		health: include('health') ? getRecordDataHealth(scope) : undefined,
		methods: include('methods') ? getMethodCatalog(scope.visitorIp) : undefined,
	};
}
