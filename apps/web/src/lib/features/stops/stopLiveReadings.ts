import type { CaptureTripReport } from '#lib/live/captureSnapshot.ts';
import { stopPrediction, uniqueDirectionHeadsigns } from '#lib/live/stopPrediction.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';

export type StopPrediction = {
	key: string;
	instance: string;
	trip: string;
	line: string | null;
	direction: number | null;
	start: string | null;
	toward: string | null;
	predictedAt: number;
	scheduledAt: number | null;
	delay: number | null;
};

export function stopLiveReadings(
	report: CaptureTripReport,
	id: string,
	now: number,
	directions?: ScheduleEdition['route_directions'],
) {
	const readings = new Map<string, StopPrediction>();
	const headsigns = new Map(
		Object.entries(directions ?? {}).map(([line, patterns]) => [
			line,
			uniqueDirectionHeadsigns(patterns),
		]),
	);
	for (const trip of report.trip_updates) {
		const line = trip.route_id || null;
		const instance = JSON.stringify([line, trip.trip_id, trip.start_date, trip.start_time]);
		for (const stop of trip.stops) {
			if (stop.stop_id !== id) continue;
			const reading = stopPrediction(trip, stop, now, line ? headsigns.get(line) : undefined);
			if (!reading) continue;
			const key = JSON.stringify([instance, stop.sequence]);
			if ((readings.get(key)?.predictedAt ?? Infinity) <= reading.predictedAt) continue;
			readings.set(key, {
				key,
				instance,
				trip: trip.trip_id,
				line,
				direction: trip.direction_id,
				start: trip.start_time,
				...reading,
			});
		}
	}
	const rows = [...readings.values()].sort((a, b) => a.predictedAt - b.predictedAt);
	const cutoff = now + 15 * 60_000;
	const count = new Set(rows.filter((row) => row.predictedAt <= cutoff).map((row) => row.instance))
		.size;
	return { rows, count };
}
