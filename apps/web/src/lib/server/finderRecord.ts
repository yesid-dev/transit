import { type FrameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { finderQuestions, type EnginePeriod } from './engineQuestion.ts';
import { getFinderSeries } from './engine.ts';
import { readingFilter } from './readingFilter.ts';

/** The Lines list's readings; with `only`, just the named readings, asked again. */
export function readLinesRecord(scope: EnginePeriod, only?: ReadonlySet<string>) {
	const include = readingFilter(only);
	return {
		punctuality: include('punctuality')
			? getFinderSeries(finderQuestions.lines.punctuality, scope)
			: undefined,
		trips: include('trips') ? getFinderSeries(finderQuestions.lines.trips, scope) : undefined,
	};
}

export function loadLinesRecord(url: URL, city: string, request: Request, clock: FrameClock) {
	const period = parseAnswerFrameState(url.searchParams, clock).period;
	const visitorIp = request.headers.get('cf-connecting-ip');
	if (!period) return null;
	const { punctuality, trips } = readLinesRecord({ ...period, city, visitorIp });
	return { period, city, punctuality: punctuality!, trips: trips! };
}

export function loadStopsRecord(url: URL, city: string, request: Request, clock: FrameClock) {
	const period = parseAnswerFrameState(url.searchParams, clock).period;
	const visitorIp = request.headers.get('cf-connecting-ip');
	return period
		? {
				period,
				city,
				punctuality: getFinderSeries(
					finderQuestions.stops.punctuality,
					{ ...period, city, visitorIp },
					request.signal,
				),
			}
		: null;
}

export type LinesRecord = NonNullable<ReturnType<typeof loadLinesRecord>>;
export type StopsRecord = NonNullable<ReturnType<typeof loadStopsRecord>>;
