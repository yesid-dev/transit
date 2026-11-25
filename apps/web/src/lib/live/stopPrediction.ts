import type { CaptureTripReport } from './captureSnapshot.ts';

type Trip = CaptureTripReport['trip_updates'][number];

export function stopPrediction(trip: Trip, stop: Trip['stops'][number], now: number) {
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
	const delay = stop.departure === null ? stop.arrival_delay : stop.departure_delay;
	// A published stop delay can inherit the trip-wide delay. Only a
	// distinguishable stop offset can recover a scheduled call.
	const scheduledAt =
		trip.relationship === 0 && delay !== null && delay !== trip.delay
			? predictedAt - delay * 1000
			: null;
	return { predictedAt, delay, scheduledAt };
}
