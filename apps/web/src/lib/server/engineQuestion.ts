import type { DateWindow } from '#lib/v1/history/window.ts';

export const QUESTION_ORIGIN = 'https://data.yesid.dev';

export type EnginePeriod = DateWindow & { city: string; visitorIp?: string | null };
export type EngineQuestion = { path: string; parameters: Record<string, string> };
export type RecordQuery = EngineQuestion & { path: '/measure' | '/ranking' };

export function questionUrl({ path, parameters }: EngineQuestion, origin = QUESTION_ORIGIN) {
	const url = new URL(`/v2${path}`, origin);
	url.search = new URLSearchParams(parameters).toString();
	return url;
}

export function cityQuestion(city: string, path: string): EngineQuestion {
	return { path: `/${encodeURIComponent(city)}${path}`, parameters: {} };
}

export function periodQuestion(
	{ city, from, to }: EnginePeriod,
	path: string,
	parameters: Record<string, string> = {},
): EngineQuestion {
	return { ...cityQuestion(city, path), parameters: { from, to, ...parameters } };
}

export function measureQuestion(
	measure: 'on_time' | 'trips_run' | 'punctuality',
	period: EnginePeriod,
) {
	return periodQuestion(period, '/measure', { measure });
}

export function overviewRankingQuestion(kind: 'line' | 'stop', period: EnginePeriod) {
	return periodQuestion(period, '/ranking', { kind, measure: 'on_time', limit: '3' });
}

export const finderQuestions = {
	lines: {
		punctuality: { measure: 'on_time', group: 'line' },
		trips: { measure: 'trips_run', group: 'line' },
	},
	stops: { punctuality: { measure: 'on_time', group: 'stop_id' } },
} as const;

export type FinderQuestionParameters = {
	measure: 'on_time' | 'trips_run';
	group: 'line' | 'stop_id';
};

export function finderQuestion(parameters: FinderQuestionParameters, period: EnginePeriod) {
	return periodQuestion(period, '/measure', parameters);
}

export function dataHealthQuestion(period: EnginePeriod) {
	return periodQuestion(period, '/data-health');
}

export const methodQuestion: EngineQuestion = { path: '/how-we-measure', parameters: {} };
export const citiesQuestion: EngineQuestion = { path: '/cities', parameters: {} };

export function scheduleQuestion(city: string) {
	return cityQuestion(city, '/schedule-index');
}
