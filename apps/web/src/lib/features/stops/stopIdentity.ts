import type { Alert, StopFile } from '#lib/v1/index.ts';
import { SEVERITY_CODES } from '#lib/v1/schemas/types.ts';

export type StopAccess = 'yes' | 'no' | 'unknown';

/**
 * Wheelchair boarding as the agency publishes it. `wheelchair_boarding` is the tri-state field;
 * the older `wheelchair` boolean is false for both "no" and "not supplied", so false alone is
 * unknown. Only an explicit "no" reads as not accessible.
 */
export function stopAccess(
	stop: Partial<Pick<StopFile, 'wheelchair' | 'wheelchair_boarding'>> | null | undefined,
): StopAccess {
	if (stop?.wheelchair_boarding === 'yes' || stop?.wheelchair_boarding === 'no')
		return stop.wheelchair_boarding;
	return stop?.wheelchair === true ? 'yes' : 'unknown';
}

export interface StopNoticeTarget {
	readonly id: string;
	readonly code: string | null | undefined;
	readonly routesServed: readonly string[] | null | undefined;
}

export interface StopNotice {
	readonly alert: Alert;
	/** "stop": the notice names this stop. "lines": it names only lines serving this stop. */
	readonly scope: 'stop' | 'lines';
	/** The lines serving this stop that the notice names (empty for a stop-scoped notice). */
	readonly lines: readonly string[];
}

export interface StopNotices {
	readonly direct: readonly StopNotice[];
	readonly lines: readonly StopNotice[];
	/** Notices in effect now in a fresh report, those naming the stop first. */
	readonly current: readonly StopNotice[];
}

function severityRank(alert: Alert): number {
	const rank = (SEVERITY_CODES as readonly string[]).indexOf(alert.severity);
	return rank === -1 ? SEVERITY_CODES.length : rank;
}

function inEffect(alert: Alert, now: number): boolean {
	const periods = alert.active_periods?.length
		? alert.active_periods
		: [{ start_utc: alert.start_utc, end_utc: alert.end_utc }];
	return periods.some(
		({ start_utc, end_utc }) =>
			(start_utc == null || Date.parse(start_utc) <= now) &&
			(end_utc == null || now < Date.parse(end_utc)),
	);
}

/**
 * The agency's notices for this stop, scoped by what each notice actually names. A notice that
 * names a line serving the stop is kept apart: it does not say this stop is affected.
 */
export function stopNotices(
	alerts: readonly Alert[] | null | undefined,
	stop: StopNoticeTarget,
	report: {
		readonly now: number;
		/** False for a retained, stale or failed report: it cannot say what is in effect now. */
		readonly reportLive: boolean;
	},
): StopNotices {
	const served = new Set(stop.routesServed ?? []);
	const matched = (alerts ?? [])
		.map((alert, order): (StopNotice & { order: number }) | null => {
			const stops = alert.stops ?? [];
			if (stops.includes(stop.id) || (stop.code != null && stops.includes(stop.code)))
				return { alert, scope: 'stop', lines: [], order };
			const lines = (alert.routes ?? []).filter((route) => served.has(route));
			return lines.length > 0 ? { alert, scope: 'lines', lines, order } : null;
		})
		.filter((notice) => notice != null)
		.sort((a, b) => severityRank(a.alert) - severityRank(b.alert) || a.order - b.order)
		.map(({ alert, scope, lines }): StopNotice => ({ alert, scope, lines }));
	const direct = matched.filter((notice) => notice.scope === 'stop');
	const lines = matched.filter((notice) => notice.scope === 'lines');
	return {
		direct,
		lines,
		current: report.reportLive
			? [...direct, ...lines].filter((notice) => inEffect(notice.alert, report.now))
			: [],
	};
}
