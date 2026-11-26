import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { classifyDelay } from '#lib/v1/live/statusBands.ts';
import { stopPrediction } from '#lib/live/stopPrediction.ts';
import {
	captureFamily,
	feedState,
	type CaptureSnapshot,
	type CaptureTripReport,
} from '#lib/live/captureSnapshot.ts';

export type LineMainStop = Pick<ScheduleEdition['stops'][number], 'id' | 'name' | 'code'>;

export function selectMainStops(
	stops: ScheduleEdition['stops'],
	directions: NonNullable<ScheduleEdition['route_directions']>[string],
): LineMainStop[] {
	const firstStops = new Set(
		directions.flatMap(({ stops }) => (stops?.[0]?.id ? [stops[0].id] : [])),
	);
	const patternedStops = new Set(
		directions.flatMap(({ stops }) => stops?.map(({ id }) => id) ?? []),
	);
	return stops
		.filter(({ id }) => patternedStops.size === 0 || patternedStops.has(id))
		.toSorted(
			(a, b) =>
				Number(firstStops.has(b.id)) - Number(firstStops.has(a.id)) ||
				(b.routes?.length ?? 0) - (a.routes?.length ?? 0),
		)
		.slice(0, 5)
		.map(({ id, name, code }) => ({ id, name, code }));
}

export function lineVehicleRows(snapshot: CaptureSnapshot | null, line: string, now: number) {
	const feed = captureFamily(snapshot, 'vehicle_positions');
	if (!snapshot?.vehicle_positions || !feed?.captured_at || feedState(feed, now) !== 'live')
		return null;
	const delayReady = feedState(captureFamily(snapshot, 'trip_updates'), now) === 'live';
	const rows = new Map<string, LiveVehicleRow>();
	for (const vehicle of snapshot.vehicle_positions) {
		if (vehicle.route_id !== line) continue;
		const reportedAt = vehicle.observed_at ? Date.parse(vehicle.observed_at) : null;
		const age = now - (reportedAt ?? Date.parse(feed.captured_at));
		if (age < -5000 || age >= (90 + feed.source_lag_seconds) * 1000) continue;
		const id = vehicle.vehicle_id ?? vehicle.id;
		const previous = rows.get(id);
		if (previous && (previous.reportedAt ?? 0) >= (reportedAt ?? 0)) continue;
		const delay = delayReady ? vehicle.delay : null;
		rows.set(id, {
			id,
			vehicleId: vehicle.vehicle_id,
			delay,
			status: classifyDelay(delay),
			toward: vehicle.direction_id,
			stop: vehicle.stop_id,
			reportedAt,
		});
	}
	return [...rows.values()];
}

export type LiveVehicleRow = {
	id: string;
	vehicleId: string | null;
	delay: number | null;
	status: ReturnType<typeof classifyDelay>;
	toward: number | null;
	stop: string | null;
	reportedAt: number | null;
};

export function lineSilentCount(snapshot: CaptureSnapshot | null, line: string, now: number) {
	if (
		!snapshot?.non_responding_by_route ||
		feedState(captureFamily(snapshot, 'vehicle_positions'), now) !== 'live' ||
		feedState(captureFamily(snapshot, 'trip_updates'), now) !== 'live'
	)
		return null;
	return snapshot.non_responding_by_route.find(({ route_id }) => route_id === line)?.count ?? 0;
}

export function nextStopPredictions(
	report: CaptureTripReport | null,
	now: number,
	headsigns?: Readonly<Record<number, string>>,
) {
	const result = new Map<
		string,
		NonNullable<ReturnType<typeof stopPrediction>> & { trip: string }
	>();
	if (!report || feedState(report.feed, now) !== 'live') return result;
	for (const trip of report.trip_updates) {
		for (const stop of trip.stops) {
			if (!stop.stop_id) continue;
			const reading = stopPrediction(trip, stop, now, headsigns);
			if (!reading || (result.get(stop.stop_id)?.predictedAt ?? Infinity) <= reading.predictedAt)
				continue;
			result.set(stop.stop_id, { trip: trip.trip_id, ...reading });
		}
	}
	return result;
}

export const delayStatuses = ['early', 'on_time', 'late', 'unknown'] as const;
export function vehicleCounts(rows: readonly LiveVehicleRow[]) {
	const counts = { early: 0, on_time: 0, late: 0, unknown: 0 };
	for (const row of rows) counts[row.status] += 1;
	return counts;
}
