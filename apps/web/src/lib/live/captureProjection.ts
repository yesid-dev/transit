import {
	AlertsFileSchema,
	NetworkFileSchema,
	StopDeparturesFileSchema,
	TripsFileSchema,
	VehiclesFileSchema,
} from '#lib/v1/schemas/index.ts';
import type { OccupancyCode, StatusCode } from '#lib/v1/schemas/types.ts';
import { feedState, type CaptureFamily, type CaptureSnapshot } from './captureSnapshot';

const occupancyByCode: readonly OccupancyCode[] = [
	'empty',
	'many_seats',
	'few_seats',
	'standing',
	'standing',
	'full',
];
function status(delay: number | null): StatusCode {
	if (delay == null) return 'unknown';
	if (delay < -60) return 'early';
	if (delay < 60) return 'on_time';
	return delay < 300 ? 'late' : 'severe';
}

function minute(delay: number | null) {
	return delay == null ? null : Math.sign(delay) * Math.round(Math.abs(delay) / 60);
}

function captureFeed(snapshot: CaptureSnapshot, family: CaptureFamily, now: number) {
	const feed = Object.values(snapshot.feeds).find((feed) => feed.family === family);
	if (!feed?.captured_at) throw new Error(`Live feed ${family}: ${feedState(feed, now)}`);
	return { ...feed, captured_at: feed.captured_at };
}

export function captureVehicles(snapshot: CaptureSnapshot, now: number) {
	const feed = captureFeed(snapshot, 'vehicle_positions', now);
	const captured = feed.captured_at;
	if (snapshot.vehicle_positions == null) throw new Error('Vehicle positions unavailable');
	const tripFeed = Object.values(snapshot.feeds).find((feed) => feed.family === 'trip_updates');
	const usableDelay = feedState(tripFeed, now) === 'live';
	const payload = VehiclesFileSchema.parse({
		generated_utc: captured,
		vehicles: snapshot.vehicle_positions.map((vehicle) => {
			const delay = usableDelay ? vehicle.delay : null;
			return {
				id: vehicle.vehicle_id ?? vehicle.id,
				route: vehicle.route_id,
				trip: vehicle.trip_id,
				lat: vehicle.latitude,
				lon: vehicle.longitude,
				bearing: vehicle.bearing == null ? null : Math.round(vehicle.bearing) % 360,
				speed_kmh: vehicle.speed_mps == null ? null : Math.round(vehicle.speed_mps * 3.6),
				status: status(delay),
				delay_min: minute(delay),
				occupancy: occupancyByCode[vehicle.occupancy ?? -1] ?? null,
				next_stop: vehicle.stop_id,
				updated_utc: captured,
				reported_utc: vehicle.observed_at,
			};
		}),
	});
	return { ...payload, captureFeed: feed, captureRevision: snapshot.published_at };
}

function stopEta(stop: NonNullable<CaptureSnapshot['trip_updates']>[number]['stops'][number]) {
	const seconds = stop.departure ?? stop.arrival;
	if (!stop.stop_id || seconds == null || seconds > 8.64e12 || stop.relationship === 1) {
		return null;
	}
	return {
		stop: stop.stop_id,
		eta_utc: new Date(seconds * 1000).toISOString(),
		delay_min: minute(stop.departure_delay ?? stop.arrival_delay),
	};
}

export function captureTrips(snapshot: CaptureSnapshot, now: number) {
	const feed = captureFeed(snapshot, 'trip_updates', now);
	const captured = feed.captured_at;
	if (snapshot.trip_updates == null) throw new Error('Trip updates unavailable');
	const payload = TripsFileSchema.parse({
		generated_utc: captured,
		feed_captured_utc: captured,
		trips: Object.fromEntries(
			snapshot.trip_updates.map((update) => [
				update.trip_id,
				{
					route: update.route_id,
					status: status(update.delay),
					delay_min: minute(update.delay),
					stops: update.stops.flatMap((stop) => {
						const eta = stopEta(stop);
						return eta ? [eta] : [];
					}),
				},
			]),
		),
	});
	return { ...payload, captureFeed: feed, captureRevision: snapshot.published_at };
}

export function captureDepartures(snapshot: CaptureSnapshot, now: number) {
	const trips = captureTrips(snapshot, now);
	const stops = new Map<
		string,
		{ route: string | null; trip: string; eta_utc: string; delay_min: number | null }[]
	>();
	for (const [tripId, trip] of Object.entries(trips.trips)) {
		for (const stop of trip.stops ?? []) {
			if (Date.parse(stop.eta_utc) < now) continue;
			const entries = stops.get(stop.stop) ?? [];
			entries.push({
				route: trip.route ?? null,
				trip: tripId,
				eta_utc: stop.eta_utc,
				delay_min: stop.delay_min ?? null,
			});
			stops.set(stop.stop, entries);
		}
	}
	const payload = StopDeparturesFileSchema.parse({
		generated_utc: trips.generated_utc,
		feed_captured_utc: trips.feed_captured_utc,
		stops: Object.fromEntries(
			[...stops].map(([stop, rows]) => [
				stop,
				rows.toSorted((a, b) => a.eta_utc.localeCompare(b.eta_utc)),
			]),
		),
	});
	return { ...payload, captureFeed: trips.captureFeed, captureRevision: trips.captureRevision };
}

function severity(level: string | null) {
	const normalized = level?.toUpperCase();
	if (normalized === 'SEVERE' || normalized === 'CRITICAL') return 'critical';
	return ['WARNING', 'HIGH', 'MAJOR'].includes(normalized ?? '') ? 'high' : 'watch';
}

export function captureAlerts(snapshot: CaptureSnapshot, now: number) {
	const feed = captureFeed(snapshot, 'alerts', now);
	const captured = feed.captured_at;
	if (snapshot.alerts == null) throw new Error('Alerts unavailable');
	const payload = AlertsFileSchema.parse({
		generated_utc: captured,
		feed_captured_utc: captured,
		alerts: snapshot.alerts.map((alert) => ({
			id: alert.id,
			severity: severity(alert.severity),
			header_key: alert.header.fr ?? alert.header.en ?? '',
			header_text: alert.header.fr ?? '',
			header_text_en: alert.header.en ?? null,
			description: alert.description.fr ?? null,
			description_en: alert.description.en ?? null,
			url: alert.url.fr ?? null,
			url_en: alert.url.en ?? null,
			cause: alert.cause,
			effect: alert.effect,
			severity_level: alert.severity,
			routes: alert.routes,
			stops: alert.stops,
			start_utc: alert.periods[0]?.[0] ?? null,
			end_utc: alert.periods[0]?.[1] ?? null,
			active_periods: alert.periods.map(([start_utc, end_utc]) => ({ start_utc, end_utc })),
		})),
	});
	return { ...payload, captureFeed: feed, captureRevision: snapshot.published_at };
}

export function captureNetwork(snapshot: CaptureSnapshot, now: number) {
	const positions = captureVehicles(snapshot, now);
	const status_dist = { on_time: 0, early: 0, late: 0, severe: 0, unknown: 0 };
	const occupancy = { empty: 0, many_seats: 0, few_seats: 0, standing: 0, full: 0 };
	let occupancyTotal = 0;
	for (const vehicle of positions.vehicles) {
		status_dist[vehicle.status] += 1;
		if (vehicle.occupancy) {
			occupancy[vehicle.occupancy] += 1;
			occupancyTotal += 1;
		}
	}
	const classified = positions.vehicles.length - status_dist.unknown;
	const percentage = (count: number, total: number) => Math.round((count * 100) / total);
	const delays = positions.vehicles
		.flatMap((vehicle) => (vehicle.delay_min == null ? [] : [vehicle.delay_min]))
		.toSorted((a, b) => a - b);
	const percentile = (share: number) => {
		if (!delays.length) return null;
		const index = share * (delays.length - 1);
		const low = delays[Math.floor(index)]!;
		const high = delays[Math.ceil(index)]!;
		return Math.round(low + (high - low) * (index % 1));
	};
	const payload = NetworkFileSchema.parse({
		generated_utc: positions.generated_utc,
		vehicles_in_service: positions.vehicles.length,
		on_time_pct:
			classified > 0 ? percentage(status_dist.on_time + status_dist.late, classified) : null,
		status_dist,
		delay_p50_min: percentile(0.5),
		delay_p90_min: percentile(0.9),
		occupancy_mix:
			occupancyTotal > 0
				? Object.fromEntries(
						Object.entries(occupancy).map(([key, count]) => [key, count / occupancyTotal]),
					)
				: null,
		non_responding: null,
		feed_freshness_s: null,
		coverage_pct: positions.vehicles.length
			? percentage(classified, positions.vehicles.length)
			: null,
	});
	return {
		...payload,
		captureFeed: positions.captureFeed,
		captureRevision: positions.captureRevision,
	};
}
