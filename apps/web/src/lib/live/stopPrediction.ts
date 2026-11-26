import type { CaptureTripReport } from './captureSnapshot.ts';

type Trip = CaptureTripReport['trip_updates'][number];

export function uniqueDirectionHeadsigns(
	directions: readonly { dir: number | null; headsign?: string | null }[] | undefined,
): Record<number, string> {
	const byDirection = new Map<number, Set<string>>();
	for (const { dir, headsign } of directions ?? []) {
		const name = headsign?.trim();
		if (dir === null || !name) continue;
		const names = byDirection.get(dir) ?? new Set<string>();
		names.add(name);
		byDirection.set(dir, names);
	}
	return Object.fromEntries(
		[...byDirection].flatMap(([dir, names]) => (names.size === 1 ? [[dir, [...names][0]]] : [])),
	);
}

export function stopPrediction(
	trip: Trip,
	stop: Trip['stops'][number],
	now: number,
	headsigns?: Readonly<Record<number, string>>,
) {
	const time = stop.departure ?? stop.arrival;
	if (
		trip.relationship === 3 ||
		trip.relationship === 7 ||
		stop.relationship === 1 ||
		stop.relationship === 2 ||
		time === null ||
		time > 8.64e12 ||
		time * 1000 < now
	)
		return null;
	const predictedAt = time * 1000;
	const departure = stop.departure !== null;
	const delay = departure ? stop.departure_delay : stop.arrival_delay;
	const scheduled = departure ? stop.scheduled_departure : stop.scheduled_arrival;
	const scheduledAt = scheduled == null || scheduled > 8.64e12 ? null : scheduled * 1000;
	const toward =
		trip.trip_headsign?.trim() ||
		(trip.direction_id === null ? null : (headsigns?.[trip.direction_id] ?? null));
	return { predictedAt, delay, scheduledAt, toward };
}
