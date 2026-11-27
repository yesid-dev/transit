import type { DateWindow } from '#lib/v1/history/window.ts';

export const QUESTION_ORIGIN = 'https://data.yesid.dev';

export type EnginePeriod = DateWindow & {
	city: string;
	visitorIp?: string | null;
};
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

/**
 * The Overview's three lowest lines or stops. Lines are ranked across every service class, the
 * same list Rankings opens on; without a class the engine ranks one class only.
 */
export function overviewRankingParameters(kind: 'line' | 'stop'): Record<string, string> {
	return { kind, measure: 'on_time', ...(kind === 'line' ? { class: 'all' } : {}), limit: '3' };
}

export function overviewRankingQuestion(kind: 'line' | 'stop', period: EnginePeriod) {
	return periodQuestion(period, '/ranking', overviewRankingParameters(kind));
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

/**
 * Questions that scan every reading of the period and take seconds of engine time for each week
 * asked. A page sends them after its quicker questions, so the quick cards fill first.
 */
const heavyMeasures = new Set([
	'crowding',
	'vehicle_days_in_service',
	'vehicle_field_completeness',
	'vehicle_reporting_gaps_per_100_hours',
	'vehicle_unfinished_trips',
	'waiting_and_gaps',
]);

export function isHeavyQuestion({ measure, vehicle }: Record<string, string | undefined>) {
	return heavyMeasures.has(measure ?? '') || (measure === 'vehicles' && vehicle !== undefined);
}

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

export function mapRecordQuestion(
	period: EnginePeriod,
	line?: string,
	direction?: string,
	layer?: 'corridors',
) {
	return periodQuestion(period, '/measure', {
		view: 'map',
		...(line || layer === 'corridors'
			? {
					measure: 'mean_time_lost',
					group: 'segment',
					...(line ? { line, ...(direction ? { direction } : {}) } : {}),
				}
			: { measure: 'late', group: 'stop_id' }),
	});
}
