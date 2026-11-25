import {
	rankingKinds,
	rankingLists,
	rankingSelection,
} from '#lib/features/rankings/rankingSelection.ts';
import { type FrameClock, parseFrameState } from '#lib/site/frameState.ts';
import { providerHasAlerts } from '#lib/site/providerCapabilities.ts';
import {
	dataHealthQuestion,
	finderQuestion,
	finderQuestions,
	mapRecordQuestion,
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

export type WarmCity = {
	id: string;
	timezone: string;
	inputs: Record<string, boolean>;
	record_through?: string | null;
};

export function defaultPeriod(clock: FrameClock) {
	return parseFrameState(new URLSearchParams(), clock).period;
}

export function defaultCityQuestions(
	city: WarmCity,
	period: NonNullable<ReturnType<typeof defaultPeriod>>,
	healthPeriod = period,
) {
	const scope = { ...period, city: city.id };
	const dailyScope = { ...scope, from: scope.to };
	const tracked = providerHasAlerts(city);
	const overview = overviewSelection(scope);
	const [trend, trendPeriod] = overview.trend;
	const questions = [
		measureQuestion(...overview.punctuality),
		periodQuestion(scope, '/measure', { measure: 'delay_distribution' }),
		measureQuestion(...overview.baseline),
		measureQuestion(...overview.delivery),
		periodQuestion(trendPeriod, trend.path, trend.parameters),
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
		...dailyQuestions(dailyScope)
			.questions.filter(({ section }) => tracked || section !== 'messages')
			.map(({ query: { path, parameters } }) => periodQuestion(dailyScope, path, parameters)),
		...[...networkQuestions(), ...(tracked ? alertQuestions(scope) : [])].map(
			({ query: { path, parameters } }) => periodQuestion(scope, path, parameters),
		),
		dataHealthQuestion({ ...healthPeriod, city: city.id }),
		mapRecordQuestion(scope),
		mapRecordQuestion(scope, undefined, undefined, 'corridors'),
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
