import { alertDetailsAllowed } from '#lib/features/alerts/alertDetailsAllowed.ts';
import { previousPeriod } from '#lib/features/home/periodComparison.ts';
import { networkMeasures, type NetworkMeasure } from '#lib/features/network/networkMeasures.ts';
import type { RankingSelection } from '#lib/features/rankings/rankingSelection.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';
import type { EnginePeriod, RecordQuery } from './engineQuestion.ts';

export const overviewTrendQuery = {
	path: '/measure',
	parameters: { measure: 'on_time', group: 'day' },
} satisfies RecordQuery;

export function overviewSelection(period: EnginePeriod) {
	const previous = previousPeriod(period);
	return {
		previous,
		punctuality: ['punctuality', period],
		baseline: ['on_time', { ...period, ...previous }],
		delivery: ['trips_run', period],
		trend: [overviewTrendQuery, period],
		lines: ['line', period],
		stops: ['stop', period],
	} as const;
}

const sections = {
	answer: {},
	day: { group: 'day' },
	hour: { group: 'hour' },
	line: { group: 'line' },
	stop: { group: 'stop_id' },
	effect: { group: 'effect' },
	cause: { group: 'cause' },
	messages: { alert_details: '1' },
} as const;

type AlertSection = keyof typeof sections;
const alertScreenSections = ['answer', 'effect', 'line', 'messages'] as const;

export function alertQuery(section: string): RecordQuery | null {
	if (!Object.hasOwn(sections, section)) return null;
	return {
		path: '/measure',
		parameters: { measure: 'alert_counts', ...sections[section as AlertSection] },
	};
}

export function alertQuestions(period: DateWindow) {
	return alertScreenSections
		.filter((section) => section !== 'messages' || alertDetailsAllowed(period))
		.map((section) => ({ section, query: alertQuery(section)! }));
}

const daily = {
	punctuality: { measure: 'punctuality' },
	delivery: { measure: 'trips_run' },
	periods: { measure: 'late', group: 'hour' },
	lines: { measure: 'on_time', kind: 'line', class: 'all', limit: '3' },
	stops: { measure: 'on_time', kind: 'stop', limit: '3' },
	messages: { measure: 'alert_counts', alert_details: '1' },
} as const;

export type DailySection = keyof typeof daily;

export function dailyQuery(section: string): RecordQuery | null {
	if (!Object.hasOwn(daily, section)) return null;
	const parameters = daily[section as DailySection];
	return { path: 'kind' in parameters ? '/ranking' : '/measure', parameters };
}

export function dailyQuestions(period: DateWindow) {
	const messagesLimited = !alertDetailsAllowed(period);
	const questions = (Object.keys(daily) as DailySection[])
		.filter((section) => section !== 'messages' || !messagesLimited)
		.map((section) => ({ section, query: dailyQuery(section)! }));
	return { questions, messagesLimited };
}

export const networkRecordQuestions = {
	punctuality: { measure: 'punctuality' },
	dayTypes: { measure: 'on_time', group: 'day_type' },
	trend: { measure: 'on_time', group: 'day' },
	delivery: { measure: 'service_delivered' },
	deliveryDays: { measure: 'service_delivered', group: 'day' },
	hours: { measure: 'late', group: 'weekday_hour' },
	crowding: { measure: 'crowding' },
} satisfies Record<string, RecordQuery['parameters']>;

export function healthDiagnosticQuery(measure: NetworkMeasure): RecordQuery {
	return { path: '/measure', parameters: { measure } };
}

export function healthDiagnosticQuestions() {
	return (Object.keys(networkMeasures) as NetworkMeasure[]).map((measure) => ({
		measure,
		query: healthDiagnosticQuery(measure),
	}));
}

export function rankingsQuery({ kind, measure, serviceClass }: RankingSelection): RecordQuery {
	return {
		path: '/ranking',
		parameters: { kind, measure, ...(serviceClass ? { class: serviceClass } : {}), limit: '500' },
	};
}
