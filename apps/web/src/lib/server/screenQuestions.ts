import { alertDetailsAllowed } from '#lib/features/alerts/alertDetailsAllowed.ts';
import { previousPeriod } from '#lib/features/home/periodComparison.ts';
import type { NetworkMeasure } from '#lib/features/network/networkMeasures.ts';
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

/** The Vehicles screen's one question: every vehicle's days in service. */
export const fleetQuestion = {
	measure: 'vehicle_days_in_service',
	group: 'vehicle',
} as const satisfies RecordQuery['parameters'];

export function healthDiagnosticQuery(measure: NetworkMeasure): RecordQuery {
	return { path: '/measure', parameters: { measure } };
}

/** The agency's own figures that Data health reads, in the order of its cards. */
export const agencyScorecardMeasures = [
	'vehicle_field_completeness',
	'live_trip_coverage',
	'prediction_error',
	'poll_success',
	'feed_age_at_capture',
] as const satisfies readonly NetworkMeasure[];

export type AgencyScorecardMeasure = (typeof agencyScorecardMeasures)[number];

export function agencyHealthQuestions() {
	return {
		scorecard: agencyScorecardMeasures.map((measure) => ({
			measure,
			query: healthDiagnosticQuery(measure),
		})),
		// One answer carries the trip and the stop counts.
		accessibility: { measure: 'accessible_trips' },
		alertEffects: alertQuery('effect')!.parameters,
		// The distinct notices, the same question Service alerts answers first.
		alertCount: alertQuery('answer')!.parameters,
	};
}

export function rankingsQuery({ kind, measure, serviceClass }: RankingSelection): RecordQuery {
	// An address without a class ranks every line, as the Overview preview does, so the
	// highlighted choice and the list always agree. A class narrows it only when chosen.
	const lineClass = kind === 'line' ? (serviceClass ?? 'all') : serviceClass;
	return {
		path: '/ranking',
		parameters: { kind, measure, ...(lineClass ? { class: lineClass } : {}), limit: '500' },
	};
}
