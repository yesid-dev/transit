import { getRecordAnswer, type EnginePeriod, type RecordQuery } from './engine.ts';
import type { DepartureIdentity } from '#lib/features/record/departureIdentity.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

const daily = {
	punctuality: { measure: 'punctuality' },
	delivery: { measure: 'trips_run' },
	periods: { measure: 'late', group: 'hour' },
	lines: { measure: 'on_time', kind: 'line', class: 'all', limit: '3' },
	stops: { measure: 'on_time', kind: 'stop', limit: '3' },
	messages: { measure: 'alert_counts', alert_details: '1' },
} as const;

const departure = {
	observed: { measure: 'late', group: 'day' },
	delay: { measure: 'punctuality' },
	stops: { measure: 'punctuality', group: 'stop' },
	missed: { measure: 'trips_run', group: 'day' },
} as const;

export type DailySection = keyof typeof daily;
export type DepartureSection = keyof typeof departure;

export function dailyQuery(section: string): RecordQuery | null {
	if (!Object.hasOwn(daily, section)) return null;
	const parameters = daily[section as DailySection];
	return { path: 'kind' in parameters ? '/ranking' : '/measure', parameters };
}

function departureCut({ line, direction, departure }: DepartureIdentity) {
	return { line, direction: String(direction), departure };
}

export function departureQuery(section: string, identity: DepartureIdentity): RecordQuery | null {
	if (!Object.hasOwn(departure, section)) return null;
	return {
		path: '/measure',
		parameters: { ...departure[section as DepartureSection], ...departureCut(identity) },
	};
}

export function departureDay(params: URLSearchParams, { from, to }: { from: string; to: string }) {
	const day = params.get('day');
	if (!day || day < from || day > to) return to;
	const date = new Date(`${day}T00:00:00Z`);
	return Number.isFinite(+date) && date.toISOString().slice(0, 10) === day ? day : to;
}

export function dailyAlertDetailsAllowed({ from, to }: DateWindow): boolean {
	const elapsed = Date.parse(to) - Date.parse(from);
	return elapsed >= 0 && elapsed < 7 * 86_400_000;
}

export function loadDailyRecord(period: EnginePeriod) {
	const messagesLimited = !dailyAlertDetailsAllowed(period);
	const sections = (Object.keys(daily) as DailySection[])
		.filter((section) => section !== 'messages' || !messagesLimited)
		.map((section) => ({
			section,
			answer: getRecordAnswer(dailyQuery(section)!, period),
		}));
	return { sections, messagesLimited };
}

export function loadDepartureRecord(
	period: EnginePeriod,
	identity: DepartureIdentity,
	day: string,
) {
	return (Object.keys(departure) as DepartureSection[]).map((section) => ({
		section,
		answer: getRecordAnswer(
			departureQuery(section, identity)!,
			section === 'stops' ? { ...period, from: day, to: day } : period,
		),
	}));
}

export async function loadDepartureLive(period: EnginePeriod, identity: DepartureIdentity) {
	const result = await getRecordAnswer(
		{ path: '/measure', parameters: { measure: 'trips_run', ...departureCut(identity) } },
		period,
	);
	if (result.kind !== 'answer' || !('value' in result.answer) || result.lastGood) return [];
	return result.answer.evidence.trip_ids ?? [];
}
