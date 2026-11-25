import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import { finderQuestions } from './engineQuestion.ts';
import { getFinderSeries } from './engine.ts';

function finderPeriod(url: URL, timeZone: string | undefined, recordThrough?: string | null) {
	return parseFrameState(url.searchParams, frameToday(timeZone), recordThrough).period;
}

export function loadLinesRecord(
	url: URL,
	city: string,
	request: Request,
	timeZone: string | undefined,
	recordThrough?: string | null,
) {
	const period = finderPeriod(url, timeZone, recordThrough);
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

export function loadStopsRecord(
	url: URL,
	city: string,
	request: Request,
	timeZone: string | undefined,
	recordThrough?: string | null,
) {
	const period = finderPeriod(url, timeZone, recordThrough);
	const visitorIp = request.headers.get('cf-connecting-ip');
	return period
		? {
				period,
				city,
				punctuality: getFinderSeries(finderQuestions.stops.punctuality, {
					...period,
					city,
					visitorIp,
				}),
			}
		: null;
}

export type LinesRecord = NonNullable<ReturnType<typeof loadLinesRecord>>;
export type StopsRecord = NonNullable<ReturnType<typeof loadStopsRecord>>;
