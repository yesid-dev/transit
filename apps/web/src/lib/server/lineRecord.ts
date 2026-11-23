import { getRecordAnswer, type RecordQuery, type EnginePeriod } from './engine.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

const record = {
	punctuality: { measure: 'punctuality' },
	daily: { measure: 'on_time', group: 'day' },
	hourly: { measure: 'late', group: 'weekday_hour' },
	directions: { measure: 'punctuality', group: 'direction' },
	stops: { measure: 'punctuality', group: 'stop' },
	waiting: { measure: 'waiting_and_gaps' },
	offered: { measure: 'scheduled_frequency', group: 'hour' },
	delivery: { measure: 'trips_run', group: 'departure' },
	late: { measure: 'late', kind: 'departure', limit: '8' },
	crowding: { measure: 'crowding' },
	alerts: { measure: 'alert_counts' },
} as const;

const schedule = {
	frequency: { measure: 'scheduled_frequency' },
	boundaries: { measure: 'service_delivered', group: 'day_type' },
} as const;

export const lineRecordQueries = { ...record, ...schedule };
export type LineSection = keyof typeof lineRecordQueries;
export type LineDirection = '0' | '1' | null;

export function lineDirection(params: URLSearchParams): LineDirection {
	const direction = params.get('direction');
	return direction === '0' || direction === '1' ? direction : null;
}

export function lineRecordQuery(
	section: LineSection,
	line: string,
	direction: LineDirection,
): RecordQuery {
	const parameters = lineRecordQueries[section];
	return {
		path: 'kind' in parameters ? '/ranking' : '/measure',
		parameters: {
			...parameters,
			line,
			// The comparison always shows both directions. Alerts have only a line cut.
			...(direction && section !== 'alerts' && section !== 'directions' ? { direction } : {}),
		},
	};
}

export function loadLineRecord(
	view: 'record' | 'schedule',
	period: DateWindow,
	city: string,
	line: string,
	direction: LineDirection,
	visitorIp?: EnginePeriod['visitorIp'],
) {
	const sections = (
		view === 'record' ? Object.keys(record) : Object.keys(schedule)
	) as LineSection[];
	return {
		view,
		period,
		city,
		line,
		direction,
		sections: sections.map((section) => ({
			section,
			answer: getRecordAnswer(lineRecordQuery(section, line, direction), {
				...period,
				city,
				...(visitorIp ? { visitorIp } : {}),
			}),
		})),
	};
}
