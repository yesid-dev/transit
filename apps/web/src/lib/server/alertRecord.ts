import { getRecordAnswer, type EnginePeriod } from './engine.ts';
import { alertQuestions } from './screenQuestions.ts';
export { alertQuery } from './screenQuestions.ts';

/** Service alerts' readings; `only` names the sections to ask again. */
export function loadAlertRecord(period: EnginePeriod, only?: ReadonlySet<string>) {
	return alertQuestions(period)
		.filter(({ section }) => !only || only.has(section))
		.map(({ section, query }) => ({ section, answer: getRecordAnswer(query, period) }));
}
