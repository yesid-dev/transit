import {
	rankingKinds,
	rankingLists,
	rankingSelection,
} from '#lib/features/rankings/rankingSelection.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import { providerHasAlerts } from '#lib/site/providerCapabilities.ts';
import {
	dataHealthQuestion,
	finderQuestion,
	finderQuestions,
	measureQuestion,
	methodQuestion,
	overviewRankingQuestion,
	periodQuestion,
	questionUrl,
	scheduleQuestion,
} from './engineQuestion.ts';
import {
	alertQuestions,
	dailyQuestions,
	networkQuestions,
	overviewSelection,
	rankingsQuery,
} from './screenQuestions.ts';

export type WarmCity = { id: string; timezone: string; inputs: Record<string, boolean> };

export function defaultPeriod(now: Date, timeZone: string) {
	return parseFrameState(new URLSearchParams(), frameToday(timeZone, now)).period;
}

export function defaultCityQuestions(
	city: WarmCity,
	period: NonNullable<ReturnType<typeof defaultPeriod>>,
) {
	const scope = { ...period, city: city.id };
	const overview = overviewSelection(scope);
	const questions = [
		measureQuestion(...overview.punctuality),
		measureQuestion(...overview.baseline),
		measureQuestion(...overview.delivery),
		overviewRankingQuestion(...overview.lines),
		overviewRankingQuestion(...overview.stops),
		...Object.values(finderQuestions).flatMap((finder) =>
			Object.values(finder).map((parameters) => finderQuestion(parameters, scope)),
		),
		...rankingKinds
			.map((kind) =>
				rankingsQuery(rankingSelection(rankingLists[kind].path, new URLSearchParams({ kind }))),
			)
			.map(({ path, parameters }) => periodQuestion(scope, path, parameters)),
		...[
			...dailyQuestions(scope).questions,
			...networkQuestions(),
			...(providerHasAlerts(city) ? alertQuestions(scope) : []),
		].map(({ query: { path, parameters } }) => periodQuestion(scope, path, parameters)),
		dataHealthQuestion(scope),
		scheduleQuestion(city.id),
	];
	const urls = questions.map((question) => {
		const url = questionUrl(question);
		url.searchParams.sort();
		return url.href;
	});
	return [...new Set(urls)];
}

// The Data health and How we measure screens share this city-independent request.
export const sharedDefaultQuestion = questionUrl(methodQuestion).href;
