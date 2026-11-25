import { type FrameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { finderQuestions } from './engineQuestion.ts';
import { getFinderSeries } from './engine.ts';

export function loadLinesRecord(url: URL, city: string, request: Request, clock: FrameClock) {
	const period = parseAnswerFrameState(url.searchParams, clock).period;
	const visitorIp = request.headers.get('cf-connecting-ip');
	return period
		? {
				period,
				city,
				punctuality: getFinderSeries(finderQuestions.lines.punctuality, {
					...period,
					city,
					visitorIp,
				}),
				trips: getFinderSeries(finderQuestions.lines.trips, { ...period, city, visitorIp }),
			}
		: null;
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
					{
						...period,
						city,
						visitorIp,
						fixtureScope: request.headers.get('x-transit-fixture-scope') ?? undefined,
					},
					request.signal,
				),
			}
		: null;
}

export type LinesRecord = NonNullable<ReturnType<typeof loadLinesRecord>>;
export type StopsRecord = NonNullable<ReturnType<typeof loadStopsRecord>>;
