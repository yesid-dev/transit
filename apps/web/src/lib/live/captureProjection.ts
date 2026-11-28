import {
	AlertsFileSchema,
	LiveNetworkFileSchema,
	LiveStopDeparturesFileSchema,
	LiveTripsFileSchema,
	LiveVehiclesFileSchema,
} from '#lib/v1/schemas/index.ts';
import type { OccupancyCode, StatusCode } from '#lib/v1/schemas/types.ts';
import { classifyDelay } from '#lib/v1/live/statusBands.ts';
import {
	captureDisplayState,
	feedState,
	type CaptureFamily,
	type CaptureSnapshot,
	type CaptureTripReport,
} from './captureSnapshot';

const occupancyByCode: readonly OccupancyCode[] = [
	'empty',
	'many_seats',
	'few_seats',
	'standing',
	'standing',
	'full',
];
function minute(delay: number | null) {
	return delay == null ? null : Math.sign(delay) * Math.round(Math.abs(delay) / 60);
}

function captureFeed(snapshot: CaptureSnapshot, family: CaptureFamily, now: number) {
	const feed = Object.values(snapshot.feeds).find((feed) => feed.family === family);
	if (!feed?.captured_at) throw new Error(`Live feed ${family}: ${feedState(feed, now)}`);
	return { ...feed, captured_at: feed.captured_at };
}

function publication(city: string, feed: { family: CaptureFamily; captured_at: string }) {
	return {
		schema_version: 2,
		generated_utc: feed.captured_at,
		// Each feed can keep serving its previous capture while other feeds advance.
		publish_generation_id: `${city}@${feed.family}:${feed.captured_at}`,
		methodology_version: 'capture-live-v2',
	};
}

export function captureVehicles(snapshot: CaptureSnapshot, now: number) {
	const feed = captureFeed(snapshot, 'vehicle_positions', now);
	const captured = feed.captured_at;
	if (snapshot.vehicle_positions == null) throw new Error('Vehicle positions unavailable');
	const tripFeed = Object.values(snapshot.feeds).find((feed) => feed.family === 'trip_updates');
	const usableDelay = feedState(tripFeed, now) === 'live';
	const payload = LiveVehiclesFileSchema.parse({
		...publication(snapshot.city, feed),
		vehicles: snapshot.vehicle_positions.map((vehicle) => {
			const delay = usableDelay ? vehicle.delay : null;
			return {
				id: vehicle.vehicle_id ?? vehicle.id,
				route: vehicle.route_id,
				trip: vehicle.trip_id,
				direction_id: vehicle.direction_id,
				lat: vehicle.latitude,
				lon: vehicle.longitude,
				bearing: vehicle.bearing == null ? null : Math.round(vehicle.bearing) % 360,
				speed_kmh: vehicle.speed_mps == null ? null : Math.round(vehicle.speed_mps * 3.6),
				status: classifyDelay(delay),
				delay_min: minute(delay),
				occupancy: occupancyByCode[vehicle.occupancy ?? -1] ?? null,
				next_stop: vehicle.stop_id,
				updated_utc: captured,
				reported_utc: vehicle.observed_at,
			};
		}),
	});
	return {
		...payload,
		captureFeed: feed,
		capturePublishedAt: snapshot.published_at,
		captureRevision: JSON.stringify([snapshot.published_at, feed, usableDelay]),
	};
}

function stopEta(
	stop: CaptureTripReport['trip_updates'][number]['stops'][number],
	usableDelay: boolean,
) {
	const seconds = stop.departure ?? stop.arrival;
	if (!stop.stop_id || seconds == null || seconds > 8.64e12 || [1, 2].includes(stop.relationship)) {
		return null;
	}
	const delay = usableDelay
		? stop.departure == null
			? stop.arrival_delay
			: stop.departure_delay
		: null;
	return {
		stop: stop.stop_id,
		eta_utc: new Date(seconds * 1000).toISOString(),
		delay_min: minute(delay),
		status: classifyDelay(delay),
	};
}

export function captureTrips(report: CaptureTripReport, now: number) {
	const feed = report.feed;
	const usableDelay = feedState(feed, now) === 'live';
	const captured = feed.captured_at;
	if (!captured) throw new Error('Trip updates unavailable');
	const payload = LiveTripsFileSchema.parse({
		...publication(report.city, { ...feed, captured_at: captured }),
		feed_captured_utc: captured,
		trips: Object.fromEntries(
			report.trip_updates.map((update) => [
				update.trip_id,
				{
					route: update.route_id,
					...(update.start_time ? { start_time: update.start_time } : {}),
					...(update.trip_headsign ? { headsign: update.trip_headsign } : {}),
					...(update.scheduled_start != null
						? {
								first_departure: {
									stop: update.scheduled_origin ?? null,
									departure: update.scheduled_start,
								},
							}
						: {}),
					...(update.direction_id === null ? {} : { direction_id: update.direction_id }),
					...(update.stops.length
						? {
								scheduled_stops: update.stops.flatMap((stop) =>
									stop.stop_id
										? [
												{
													stop: stop.stop_id,
													sequence: stop.sequence,
													departure: stop.scheduled_departure ?? null,
												},
											]
										: [],
								),
							}
						: {}),
					status: classifyDelay(usableDelay ? update.delay : null),
					delay_min: minute(usableDelay ? update.delay : null),
					stops: update.stops.flatMap((stop) => {
						const eta = stopEta(stop, usableDelay);
						return eta ? [eta] : [];
					}),
				},
			]),
		),
	});
	return { ...payload, captureFeed: feed, captureRevision: JSON.stringify([feed, usableDelay]) };
}

export function captureDepartures(report: CaptureTripReport, now: number) {
	const trips = captureTrips(report, now);
	const stops = new Map<
		string,
		{
			route: string | null;
			trip: string;
			eta_utc: string;
			delay_min: number | null;
			status?: StatusCode;
			direction_id?: number | null;
			start_time?: string;
		}[]
	>();
	const descriptions = new Map(report.trip_updates.map((trip) => [trip.trip_id, trip]));
	for (const [tripId, trip] of Object.entries(trips.trips)) {
		const description = descriptions.get(tripId);
		for (const stop of trip.stops ?? []) {
			if (Date.parse(stop.eta_utc) < now) continue;
			const entries = stops.get(stop.stop) ?? [];
			entries.push({
				route: trip.route ?? null,
				trip: tripId,
				eta_utc: stop.eta_utc,
				delay_min: stop.delay_min ?? null,
				status: stop.status,
				...(description?.start_time
					? {
							direction_id: description.direction_id,
							start_time: description.start_time,
						}
					: {}),
			});
			stops.set(stop.stop, entries);
		}
	}
	const payload = LiveStopDeparturesFileSchema.parse({
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

const delayBands = [null, -5, -2, 0, 2, 5, 10, 15, null] as const;

function delayHistogram(delays: readonly number[]) {
	if (!delays.length) return null;
	return delayBands.slice(0, -1).map((lo_min, index) => {
		const hi_min = delayBands[index + 1] ?? null;
		const count = delays.filter(
			(delay) => (lo_min == null || delay >= lo_min) && (hi_min == null || delay < hi_min),
		).length;
		return { lo_min, hi_min, count };
	});
}

export function captureAlerts(snapshot: CaptureSnapshot, now: number) {
	const feed = captureFeed(snapshot, 'alerts', now);
	if (snapshot.alerts == null) throw new Error('Alerts unavailable');
	const payload = AlertsFileSchema.parse({
		...publication(snapshot.city, feed),
		feed_captured_utc: feed.captured_at,
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
	return {
		...payload,
		captureFeed: feed,
		captureRevision: JSON.stringify([snapshot.published_at, feed]),
	};
}

export function captureNetwork(snapshot: CaptureSnapshot, now: number) {
	const positions = captureVehicles(snapshot, now);
	const scheduled = snapshot.scheduled_now;
	const silent = snapshot.non_responding;
	const measured =
		scheduled != null &&
		silent != null &&
		silent <= scheduled &&
		Object.values(snapshot.feeds).every(
			(feed) =>
				feed.family === 'alerts' ||
				captureDisplayState(feed, now, snapshot.published_at) === 'live',
		);
	const status_dist = { on_time: 0, early: 0, late: 0, unknown: 0 };
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
	const payload = LiveNetworkFileSchema.parse({
		generated_utc: positions.generated_utc,
		vehicles_in_service: positions.vehicles.length,
		on_time_pct: classified > 0 ? percentage(status_dist.on_time, classified) : null,
		status_dist,
		delay_p50_min: percentile(0.5),
		delay_p90_min: percentile(0.9),
		delay_histogram: delayHistogram(delays),
		occupancy_mix:
			occupancyTotal > 0
				? Object.fromEntries(
						Object.entries(occupancy).map(([key, count]) => [key, count / occupancyTotal]),
					)
				: null,
		scheduled_now: measured ? scheduled : null,
		non_responding: measured ? silent : null,
		cancelled_now: measured ? (snapshot.cancelled_now ?? null) : null,
		non_responding_by_route: measured ? (snapshot.non_responding_by_route ?? null) : null,
		silent_trips: measured ? (snapshot.silent_trips ?? null) : null,
		schedule: snapshot.schedule ?? null,
		feed_freshness_s: null,
		coverage_pct: positions.vehicles.length
			? percentage(classified, positions.vehicles.length)
			: null,
	});
	return {
		...payload,
		captureFeed: positions.captureFeed,
		capturePublishedAt: positions.capturePublishedAt,
		captureRevision: JSON.stringify([positions.captureRevision, measured]),
	};
}
