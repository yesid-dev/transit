import { getRecordAnswer, type EnginePeriod } from './engine.ts';
import { alertQuestions } from './screenQuestions.ts';
export { alertQuery } from './screenQuestions.ts';

export function loadAlertRecord(period: EnginePeriod) {
	return alertQuestions(period).map(({ section, query }) => ({
		section,
		answer: getRecordAnswer(query, period),
	}));
}
