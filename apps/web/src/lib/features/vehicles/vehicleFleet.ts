import { intl, type Locale } from '#lib/i18n/index.ts';
import type { EngineResult, RecordAnswer, RecordSeries } from '#lib/server/engine.ts';
import { recordStateFor, type RecordState } from '#lib/features/record/recordStates.ts';

export const fleetPageSize = 20;

export function fleetView(params: Pick<URLSearchParams, 'get'>) {
	const reporting = params.get('reporting');
	const shown = params.get('shown') ?? '';
	return {
		query: (params.get('q') ?? '').trim().slice(0, 80),
		line: params.get('route') ?? '',
		reporting: reporting === 'reported' || reporting === 'silent' ? reporting : null,
		shown: /^\d{1,6}$/.test(shown) ? Math.max(fleetPageSize, Number(shown)) : fleetPageSize,
	};
}

export type FleetView = ReturnType<typeof fleetView>;

export type VehicleRecordRow = {
	id: string;
	state?: RecordState;
	days: number | null;
	hours: number | null;
	lines: number | null;
	trips: number | null;
};

function recordRow(id: string, cell: RecordSeries['cells'][number]): VehicleRecordRow {
	const counts = cell.evidence.counts;
	const days = cell.value.vehicle_days_in_service ?? counts.days_in_service ?? null;
	const state =
		cell.state === 'measured'
			? days === 0
				? 'not_reporting'
				: undefined
			: recordStateFor(cell.state);
	return {
		id,
		state,
		days: state ? null : days,
		hours: state ? null : (counts.hours_in_service ?? null),
		lines: state ? null : (counts.lines_run ?? null),
		trips: state ? null : (counts.trips_run ?? null),
	};
}

/** Project the fleet before serializing it. Counts describe the full selected period. */
export function projectVehicleFleet(answer: RecordSeries, view: FleetView, locale: Locale) {
	const all = answer.cells.flatMap((cell) =>
		typeof cell.key.vehicle === 'string' ? [recordRow(cell.key.vehicle, cell)] : [],
	);
	const compare = intl.collator(locale, { numeric: true, sensitivity: 'base' }).compare;
	const query = view.query.toLowerCase();
	const matches = all.filter(
		(row) =>
			row.id.toLowerCase().includes(query) &&
			(view.reporting === 'reported'
				? (row.days ?? 0) > 0
				: view.reporting === 'silent'
					? row.state === 'not_reporting'
					: true),
	);
	matches.sort((a, b) => compare(a.id, b.id));
	const reported = matches.filter(({ days }) => (days ?? 0) > 0).length;
	const didNotReport = matches.filter(({ state }) => state === 'not_reporting').length;
	return {
		rows: matches.slice(0, view.shown),
		total: matches.length,
		reportingCounts: {
			reported,
			didNotReport,
			unmeasured: matches.length - reported - didNotReport,
		},
		fleet: all.length,
		active: all.filter(({ days }) => (days ?? 0) > 0).length,
		canFilter:
			all.some(({ state }) => state === 'not_reporting') && all.some(({ days }) => (days ?? 0) > 0),
		daysInService: all.reduce<number | null>(
			(sum, row) => (row.days === null ? sum : (sum ?? 0) + row.days),
			null,
		),
		trips: all.reduce<number | null>(
			(sum, row) => (row.trips === null ? sum : (sum ?? 0) + row.trips),
			null,
		),
		evidence: answer.evidence,
		coverageNote: answer.coverage_note,
	};
}

export function projectFleetAnswer(
	result: EngineResult<RecordAnswer>,
	view: FleetView,
	locale: Locale,
) {
	if (result.kind !== 'answer') return result;
	if ('state' in result.answer && result.answer.state === 'not_tracked')
		return { kind: 'not_tracked' as const };
	if (!('cells' in result.answer)) return { kind: 'unreachable' as const };
	return { ...result, answer: projectVehicleFleet(result.answer, view, locale) };
}

export type VehicleFleetAnswer = ReturnType<typeof projectFleetAnswer>;
