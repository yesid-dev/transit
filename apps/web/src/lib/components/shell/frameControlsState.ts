import { delocalizePath, type Locale } from '#lib/i18n/index.ts';
import { isRankingPath } from '#lib/features/rankings/rankingSelection.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { stopFrameView } from '#lib/site/stopFrame.ts';
import { networkRecordView } from '#lib/site/networkFrame.ts';
import { mapLayerFor } from '#lib/site/mapFrame.ts';
import { dateRange, longDate, recordNoticeDates } from '#lib/site/presenter.ts';
import {
	RECORD_START,
	frameDateLimit,
	parseFrameState,
	periodError,
	receiptFrameParams,
	recordAnswerPeriod,
	unpublishedRecordDates,
	type FrameClock,
} from '#lib/site/frameState.ts';
import { frameCopy } from './frameCopy.ts';

export { frameCopy };

// Reading documents, the definitions and search read no record: no View or Period to choose.
const readingPaths = [
	'/roadmap',
	'/privacy',
	'/terms',
	'/accessibility',
	'/metrics',
	'/metrics/archive',
	'/search',
];

export function frameControlsState(
	url: URL,
	clock: FrameClock,
	errorPage = false,
	options?: { alertsTracked?: boolean },
) {
	const path = delocalizePath(url.pathname).replace(/\/$/, '') || '/';
	const recordOnly =
		isRankingPath(path) || ['/lines', '/stops', '/receipt', '/download'].includes(path);
	const line = /^\/lines\/[^/]+$/.test(path);
	const stop = /^\/stop\/[^/]+$/.test(path);
	const map = path === '/map';
	const liveOnly = path.startsWith('/trip/');
	const untrackedAlerts = path === '/alerts' && options?.alertsTracked === false;
	const showRail = !errorPage && !readingPaths.includes(path) && !untrackedAlerts;
	const params =
		path === '/receipt' ? receiptFrameParams(url.searchParams, clock) : url.searchParams;
	const parsed = parseFrameState(params, clock);
	let mode = parsed.mode;
	if (recordOnly) mode = 'record';
	else if (liveOnly) mode = 'live';
	else if (line) mode = lineFrameView(url) === 'live' ? 'live' : 'record';
	else if (stop) mode = stopFrameView(url);
	else if (map) mode = mapLayerFor(url.searchParams) === 'live' ? 'live' : 'record';
	else if (path === '/network') mode = networkRecordView(url) ? 'record' : 'live';
	const usesFrameRecord =
		recordOnly ||
		line ||
		stop ||
		path.startsWith('/departure/') ||
		['/', '/alerts', '/network', '/status', '/vehicles'].includes(path) ||
		path.startsWith('/vehicle/');
	const period =
		mode === 'record' && path !== '/download' && (usesFrameRecord || map)
			? recordAnswerPeriod(parsed.period, clock)
			: parsed.period;
	const start = clock.recordStart ?? RECORD_START;
	const askedFrom = url.searchParams.get('recordFrom');
	const askedTo = url.searchParams.get('recordTo');
	const askedBeforeRecord =
		askedFrom !== null &&
		askedTo !== null &&
		periodError({ from: askedFrom, to: askedTo }, frameDateLimit(clock), start) === 'beforeRecord';
	const askedAfterRecord = unpublishedRecordDates(params, clock);
	return {
		...parsed,
		period,
		mode,
		showRail,
		// The map explains each mode itself, and the Period card below already explains Record.
		showViewHint: showRail && !recordOnly && !liveOnly && !map && mode === 'live',
		recordOnly,
		liveOnly,
		detail: line || stop,
		map,
		usesFrameRecord,
		// A link whose dates fall before the city's record is answered with other dates: say so once.
		beforeRecord:
			!errorPage && askedBeforeRecord && mode === 'record' && usesFrameRecord && parsed.period
				? { start, period: parsed.period }
				: null,
		afterRecord:
			!errorPage &&
			mode === 'record' &&
			(usesFrameRecord || map) &&
			askedAfterRecord &&
			period &&
			askedAfterRecord.from > period.to
				? { requested: askedAfterRecord, period }
				: null,
	} as const;
}

export function recordEndNotice(
	afterRecord: ReturnType<typeof frameControlsState>['afterRecord'],
	locale: Locale,
): string | null {
	if (!afterRecord) return null;
	const { requested, period } = afterRecord;
	const copy = frameCopy[locale];
	const year = period.from.slice(0, 4) !== requested.to.slice(0, 4);
	const asked = recordNoticeDates(requested, locale, year);
	const shown = recordNoticeDates(period, locale, year);
	const missing =
		requested.from === requested.to ? copy.waitingForDay(asked) : copy.waitingForDates(asked);
	const showing =
		locale === 'en'
			? frameCopy.en.showing(shown)
			: period.from === period.to
				? frameCopy.fr.showingDay(shown)
				: frameCopy.fr.showingDates(shown);
	return `${missing} ${showing}`;
}

/** The one sentence a screen shows when its link's dates fell before the record. */
export function recordStartNotice(
	beforeRecord: ReturnType<typeof frameControlsState>['beforeRecord'],
	locale: Locale,
): string | null {
	if (!beforeRecord) return null;
	const copy = frameCopy[locale];
	const { start, period } = beforeRecord;
	return [
		copy.recordStarts(longDate(start, locale)),
		period.preset === '7-days' ? copy.showingLast7 : copy.showing(dateRange(period, locale)),
	].join(' ');
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
