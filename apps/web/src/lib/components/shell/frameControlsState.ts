import { delocalizePath, type Locale } from '#lib/i18n/index.ts';
import { isRankingPath } from '#lib/features/rankings/rankingSelection.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { stopFrameView } from '#lib/site/stopFrame.ts';
import { networkRecordView } from '#lib/site/networkFrame.ts';
import { mapLayerFor } from '#lib/site/mapFrame.ts';
import { dateRange } from '#lib/site/presenter.ts';
import { parseFrameState, unpublishedYesterday, type FrameClock } from '#lib/site/frameState.ts';
import { frameCopy } from './frameCopy.ts';

export { frameCopy };

// Reading documents have no View or Period to choose.
const readingPaths = ['/roadmap', '/privacy', '/terms', '/accessibility', '/metrics/archive'];

export function frameControlsState(url: URL, clock: FrameClock, errorPage = false) {
	const path = delocalizePath(url.pathname).replace(/\/$/, '') || '/';
	const recordOnly =
		isRankingPath(path) || ['/lines', '/stops', '/receipt', '/download'].includes(path);
	const line = /^\/lines\/[^/]+$/.test(path);
	const stop = /^\/stop\/[^/]+$/.test(path);
	const map = path === '/map';
	const liveOnly = path.startsWith('/trip/');
	const showRail = !errorPage && !readingPaths.includes(path);
	const parsed = parseFrameState(
		url.searchParams,
		path === '/status' ? { ...clock, recordThrough: null } : clock,
	);
	let mode = parsed.mode;
	if (recordOnly) mode = 'record';
	else if (liveOnly) mode = 'live';
	else if (line) mode = lineFrameView(url) === 'live' ? 'live' : 'record';
	else if (stop) mode = stopFrameView(url);
	else if (map) mode = mapLayerFor(url.searchParams) === 'live' ? 'live' : 'record';
	else if (path === '/network') mode = networkRecordView(url) ? 'record' : 'live';
	return {
		...parsed,
		mode,
		showRail,
		// The map explains each mode itself: its Period card says Live shows this moment only,
		// and Record names what its layer draws. A second line would push the legend down.
		showViewHint: showRail && !recordOnly && !liveOnly && !map,
		recordOnly,
		liveOnly,
		detail: line || stop,
		map,
		waitingForYesterday:
			mode === 'record' && path !== '/download' && path !== '/status'
				? unpublishedYesterday(parsed.period, clock)
				: null,
		usesFrameRecord:
			recordOnly ||
			line ||
			stop ||
			path.startsWith('/departure/') ||
			['/', '/alerts', '/network', '/status', '/vehicles'].includes(path) ||
			path.startsWith('/vehicle/'),
	} as const;
}

export function framePeriodSummary(
	period: ReturnType<typeof parseFrameState>['period'],
	locale: Locale,
) {
	if (!period) return null;
	const copy = frameCopy[locale];
	const days = (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000 + 1;
	return {
		title:
			period.preset === '7-days' ? copy.title7 : period.preset ? copy.presets[period.preset] : null,
		dates: dateRange(period, locale),
		duration: copy.dayCount(days),
	};
}
