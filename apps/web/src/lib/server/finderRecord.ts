import { usesFinderRecord } from '#lib/site/finderFrame.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import { getFinderSeries } from './engine.ts';

function finderPeriod(url: URL) {
	return usesFinderRecord(url) ? parseFrameState(url.searchParams, frameToday()).period : null;
}

export function loadLinesRecord(url: URL, city: string, request: Request) {
	const period = finderPeriod(url);
	const visitorIp = request.headers.get('cf-connecting-ip');
	return period
		? {
				period,
				city,
				punctuality: getFinderSeries('on_time', 'line', { ...period, city, visitorIp }),
				trips: getFinderSeries('trips_run', 'line', { ...period, city, visitorIp }),
			}
		: null;
}

export function loadStopsRecord(url: URL, city: string, request: Request) {
	const period = finderPeriod(url);
	const visitorIp = request.headers.get('cf-connecting-ip');
	return period
		? {
				period,
				city,
				punctuality: getFinderSeries('on_time', 'stop_id', { ...period, city, visitorIp }),
			}
		: null;
}

export type LinesRecord = NonNullable<ReturnType<typeof loadLinesRecord>>;
export type StopsRecord = NonNullable<ReturnType<typeof loadStopsRecord>>;
