import { getScorecardAnswer, type EnginePeriod } from './engine.ts';

import { networkQuestions } from './screenQuestions.ts';
export { networkRecordQuery } from './screenQuestions.ts';

export function loadNetworkRecord(scope: EnginePeriod) {
	const { from, to, city } = scope;
	return {
		period: { from, to },
		city,
		sections: networkQuestions().map(({ measure, query }) => ({
			measure,
			answer: getScorecardAnswer(query, scope),
		})),
	};
}
