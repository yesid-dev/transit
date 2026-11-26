import { describe, expect, it } from 'vitest';
import { captureTripScopeSchema, type CaptureTripReport } from '#lib/live/captureSnapshot.ts';
import { stopLiveReadings } from './stopLiveReadings.ts';

const now = Date.parse('2026-11-25T13:12:00Z');
const captured = new Date(now).toISOString();
function trip(
	id: string,
	minutes: number,
	changes: Partial<CaptureTripReport['trip_updates'][number]> = {},
): CaptureTripReport['trip_updates'][number] {
	return {
		trip_id: id,
		route_id: '51',
		direction_id: 1,
		start_date: '20261125',
		start_time: '08:00:00',
		relationship: 0,
		delay: null,
		stops: [
			{
				stop_id: '52847',
				sequence: 15,
				arrival: null,
				departure: now / 1000 + minutes * 60,
				arrival_delay: null,
				departure_delay: 120,
				relationship: 0,
			},
		],
		...changes,
	};
}
function report(...trips: CaptureTripReport['trip_updates']): CaptureTripReport {
	return {
		version: 2,
		city: 'stm',
		feed: {
			family: 'trip_updates',
			captured_at: captured,
			source_at: captured,
			fresh_for_seconds: 90,
			source_lag_seconds: 0,
			read_failed: false,
		},
		trip_updates: trips,
	};
}

describe('Stop trip predictions', () => {
	it('orders future stop calls, counts distinct trip instances inside fifteen minutes, and omits cancelled calls', () => {
		const near = trip('near', 5);
		const recurring = trip('near', 0);
		recurring.stops[0].sequence = 12;
		const skipped = trip('skip', 3);
		skipped.stops[0].relationship = 1;
		const otherStop = trip('other', 3);
		otherStop.stops[0].stop_id = 'other';
		const readings = stopLiveReadings(
			report(
				trip('later', 17),
				skipped,
				near,
				recurring,
				trip('boundary', 15),
				near,
				otherStop,
				trip('past', -1),
				trip('cancelled', 5, { relationship: 3 }),
			),
			'52847',
			now,
		);
		expect(readings.count).toBe(2);
		expect(readings.rows.map(({ trip }) => trip)).toEqual(['near', 'near', 'boundary', 'later']);
		expect(readings.rows[1].scheduledAt).toBeNull();
	});

	it('uses published departure and arrival calls, and falls back only to a single headsign', () => {
		const departure = trip('departure', 5, { trip_headsign: ' Montréal-Ouest ', delay: 120 });
		Object.assign(departure.stops[0], {
			arrival: now / 1000 + 280,
			scheduled_arrival: now / 1000 + 155,
			scheduled_departure: now / 1000 + 180,
		});
		const arrival = trip('arrival', 6, { route_id: '165', trip_headsign: null });
		Object.assign(arrival.stops[0], {
			departure: null,
			arrival: now / 1000 + 360,
			arrival_delay: 60,
			scheduled_arrival: now / 1000 + 300,
			scheduled_departure: now / 1000 + 390,
		});
		const unmatched = trip('unmatched', 7, { trip_headsign: ' ' });
		Object.assign(unmatched.stops[0], {
			scheduled_departure: null,
			scheduled_arrival: now / 1000 + 300,
		});
		const updates = captureTripScopeSchema.parse(
			report(departure, arrival, unmatched, trip('older', 8)),
		);
		const readings = stopLiveReadings(updates, '52847', now, {
			51: [
				{ dir: 1, headsign: 'Laurier' },
				{ dir: 1, headsign: 'Montréal-Ouest' },
			],
			165: [
				{ dir: 1, headsign: 'Station Guy-Concordia' },
				{ dir: 1, headsign: ' Station Guy-Concordia ' },
				{ dir: 0, headsign: 'Côte-Vertu' },
			],
		});
		expect(
			readings.rows.map(({ toward, scheduledAt, delay }) => ({ toward, scheduledAt, delay })),
		).toEqual([
			{ toward: 'Montréal-Ouest', scheduledAt: now + 180_000, delay: 120 },
			{ toward: 'Station Guy-Concordia', scheduledAt: now + 300_000, delay: 60 },
			{ toward: null, scheduledAt: null, delay: 120 },
			{ toward: null, scheduledAt: null, delay: 120 },
		]);
	});
});
