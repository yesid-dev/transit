import type {
	CaptureFamily,
	CaptureSnapshot,
	CaptureTripReport,
} from '../src/lib/live/captureSnapshot';

export const captureUrl = /\/api\/live\?city=[a-z0-9_-]+$/;
export const liveTripsUrl = /\/api\/live-trips\?city=[a-z0-9_-]+&/;
type Vehicle = NonNullable<CaptureSnapshot['vehicle_positions']>[number];
type TripUpdate = CaptureTripReport['trip_updates'][number];
type Prediction = { stop: string; eta_utc: string; delay_min?: number | null };

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

export function captureTrip(
	id: string,
	route: string | null,
	stops: readonly Prediction[],
	delay: number | null = null,
): TripUpdate {
	return {
		trip_id: id,
		route_id: route,
		direction_id: null,
		start_date: null,
		start_time: null,
		relationship: 0,
		delay,
		stops: stops.map(({ stop, eta_utc, delay_min }, i) => ({
			stop_id: stop,
			sequence: i + 1,
			arrival: null,
			departure: Date.parse(eta_utc) / 1_000,
			arrival_delay: null,
			departure_delay: delay_min == null ? null : delay_min * 60,
			relationship: 0,
		})),
	};
}

export function captureTripReport(
	city: string,
	timestamp: string,
	trip_updates: TripUpdate[],
): CaptureTripReport {
	return {
		version: 2,
		city,
		feed: {
			family: 'trip_updates',
			fresh_for_seconds: 90,
			captured_at: timestamp,
			source_at: timestamp,
			source_lag_seconds: 0,
			read_failed: false,
		},
		trip_updates,
	};
}

export function captureFleet(at: number, city: string, delays: readonly (number | null)[]) {
	return captureFixture(at, {
		city,
		vehicle_positions: delays.map((delay, i) =>
			captureVehicle(at, { id: `report-${i}`, vehicle_id: `fixture-${i}`, delay }),
		),
	});
}

export function layoutCapture(city: string, overrides: Partial<Vehicle> = {}) {
	const at = Date.parse('2026-06-15T12:00:00Z');
	return captureFixture(at, {
		city,
		vehicle_positions: [
			captureVehicle(at, {
				vehicle_id: 'layout-bus',
				latitude: city === 'stm' ? 45.51 : 45.41,
				longitude: city === 'stm' ? -73.59 : -75.69,
				delay: 0,
				bearing: 90,
				speed_mps: 40 / 3.6,
				occupancy: 1,
				...overrides,
			}),
		],
	});
}

export function captureFixture(
	at: number,
	options: Partial<Pick<CaptureSnapshot, 'city' | 'vehicle_positions' | 'alerts'>> = {},
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
		version: 2,
		city: 'stm',
		published_at: timestamp,
		stable_vehicle_ids: true,
		feeds: {
			vehicle_positions: feed('vehicle_positions', 60),
			trip_updates: feed('trip_updates', 90),
			i3_alerts: feed('alerts', 900),
		},
		vehicle_positions: [],
		alerts: [],
		...options,
	};
}
