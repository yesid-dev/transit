import type { CaptureFamily, CaptureSnapshot } from '../src/lib/live/captureSnapshot';

export const captureUrl = /\/api\/live\?city=[a-z0-9_-]+$/;
type Vehicle = NonNullable<CaptureSnapshot['vehicle_positions']>[number];

export function captureVehicle(at: number, overrides: Partial<Vehicle> = {}): Vehicle {
	return {
		id: 'report-40061',
		vehicle_id: '40061',
		route_id: '24',
		trip_id: 'T1',
		start_date: null,
		start_time: null,
		direction_id: 1,
		status: 1,
		delay: 240,
		stop_id: 'S1',
		stop_sequence: 1,
		occupancy: 2,
		occupancy_percentage: null,
		latitude: 45.5,
		longitude: -73.6,
		bearing: null,
		speed_mps: null,
		observed_at: new Date(at).toISOString(),
		...overrides,
	};
}

export function captureFixture(
	at: number,
	options: Partial<
		Pick<CaptureSnapshot, 'city' | 'vehicle_positions' | 'trip_updates' | 'alerts'>
	> = {},
): CaptureSnapshot {
	const timestamp = new Date(at).toISOString();
	const feed = (family: CaptureFamily, fresh_for_seconds: number) => ({
		family,
		fresh_for_seconds,
		captured_at: timestamp,
		source_at: timestamp,
		source_lag_seconds: 0,
		read_failed: false,
	});
	return {
		version: 1,
		city: 'stm',
		published_at: timestamp,
		stable_vehicle_ids: true,
		feeds: {
			vehicle_positions: feed('vehicle_positions', 60),
			trip_updates: feed('trip_updates', 90),
			i3_alerts: feed('alerts', 900),
		},
		vehicle_positions: [],
		trip_updates: [],
		alerts: [],
		...options,
	};
}
