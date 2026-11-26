import '#lib/site/configureBrowserValidation.ts';
import { z } from 'zod';
import { LiveScheduleEvidenceSchema, SilentTripsSchema } from '#lib/v1/schemas/network.ts';

const stamp = z.iso.datetime({ offset: true });
const sourceStamp = stamp.nullable();
const text = z.string().nullable();
const ordinal = z.int().nonnegative().nullable();
const reading = z.number().nullable();
const optionalCount = z.int().nonnegative().nullable().optional();

const vehicle = z.object({
	id: z.string(),
	vehicle_id: text,
	trip_id: text,
	start_date: text,
	start_time: text,
	route_id: text,
	direction_id: ordinal,
	latitude: z.number().min(-90).max(90),
	longitude: z.number().min(-180).max(180),
	bearing: reading,
	speed_mps: reading,
	stop_id: text,
	stop_sequence: ordinal,
	status: ordinal,
	occupancy: ordinal,
	occupancy_percentage: ordinal,
	observed_at: sourceStamp,
	delay: reading,
});

const tripUpdate = z.object({
	trip_id: z.string(),
	trip_headsign: text.optional(),
	route_id: text,
	direction_id: ordinal,
	start_date: text,
	start_time: text,
	relationship: z.int(),
	delay: reading,
	stops: z.array(
		z.object({
			stop_id: text,
			sequence: ordinal,
			arrival: ordinal,
			departure: ordinal,
			scheduled_arrival: ordinal.optional(),
			scheduled_departure: ordinal.optional(),
			arrival_delay: reading,
			departure_delay: reading,
			relationship: z.int(),
		}),
	),
});

const translations = z.record(z.string(), z.string());
const alert = z.object({
	id: z.string(),
	header: translations,
	description: translations,
	url: translations,
	cause: text,
	effect: text,
	severity: text,
	routes: z.array(z.string()),
	stops: z.array(z.string()),
	periods: z.array(z.tuple([sourceStamp, sourceStamp])),
});

const family = z.enum(['vehicle_positions', 'trip_updates', 'alerts']);
const feed = z.object({
	family,
	captured_at: sourceStamp,
	source_at: sourceStamp,
	fresh_for_seconds: z.int().positive(),
	source_lag_seconds: z.int().nonnegative(),
	read_failed: z.boolean(),
	expected_every_seconds: z.int().positive().nullish(),
	bytes: optionalCount,
});

export const captureSnapshotSchema = z.object({
	version: z.literal(2),
	city: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
	published_at: stamp,
	stable_vehicle_ids: z.boolean().nullable(),
	feeds: z.record(z.string(), feed),
	vehicle_positions: z.array(vehicle).nullable(),
	alerts: z.array(alert).nullable(),
	scheduled_now: optionalCount,
	non_responding: optionalCount,
	cancelled_now: optionalCount,
	non_responding_by_route: z
		.array(z.object({ route_id: z.string(), count: z.int().nonnegative() }))
		.nullable()
		.optional(),
	silent_trips: SilentTripsSchema,
	schedule: LiveScheduleEvidenceSchema,
});

export const captureTripScopeSchema = z.object({
	version: z.literal(2),
	city: z.string(),
	feed,
	trip_updates: z.array(tripUpdate),
});

export type CaptureScope = { kind: 'line' | 'stop' | 'trip'; id: string };
export type LiveTripScope = CaptureScope | { kind: 'vehicle'; id: string };
export type CaptureTripReport = z.infer<typeof captureTripScopeSchema>;

export type CaptureSnapshot = z.infer<typeof captureSnapshotSchema>;
export type CaptureFamily = z.infer<typeof family>;
export type CaptureFeed = z.infer<typeof feed>;

export function captureFamily(snapshot: CaptureSnapshot | null, family: CaptureFamily) {
	return Object.values(snapshot?.feeds ?? {}).find((feed) => feed.family === family);
}

export interface CaptureEvidence {
	readonly captureFeed?: CaptureFeed;
	readonly captureRevision?: string;
}

export class CaptureScopeRefreshing extends Error {
	constructor(readonly retryAfterMs: number) {
		super('Live trip publication is refreshing');
	}
}

export function feedState(
	feed: CaptureFeed | undefined,
	now: number,
	deliveryGraceSeconds = 0,
): 'not_tracked' | 'no_live_data' | 'unknown' | 'stale' | 'refresh_unavailable' | 'live' {
	if (!feed) return 'not_tracked';
	if (!feed.captured_at) return 'no_live_data';
	const captured = Date.parse(feed.captured_at);
	const observed = feed.source_at ? Date.parse(feed.source_at) : captured;
	const age = now - captured;
	const sourceAge = now - observed;
	if (!Number.isFinite(age) || !Number.isFinite(sourceAge) || age < -5_000 || sourceAge < -5_000) {
		return 'unknown';
	}
	const limit = feed.fresh_for_seconds * 1_000;
	const deliveryGrace = deliveryGraceSeconds * 1_000;
	// A retained answer can age in transit, but delivery cannot explain an old source in a fresh capture.
	const sourceGrace = Math.min(deliveryGrace, Math.max(0, age));
	if (
		age >= limit + deliveryGrace ||
		sourceAge >= limit + feed.source_lag_seconds * 1_000 + sourceGrace
	)
		return 'stale';
	return feed.read_failed ? 'refresh_unavailable' : 'live';
}

/** Public capture status uses the declared vehicle capture cadence, without delivery grace. */
export function captureDisplayState(
	feed: CaptureFeed | undefined,
	now: number,
): ReturnType<typeof feedState> {
	if (feed?.family !== 'vehicle_positions' || !feed.captured_at || !feed.expected_every_seconds)
		return feedState(feed, now);
	const age = now - Date.parse(feed.captured_at);
	if (!Number.isFinite(age) || age < -5_000) return 'unknown';
	if (age > 3 * feed.expected_every_seconds * 1_000) return 'stale';
	return feed.read_failed ? 'refresh_unavailable' : 'live';
}

export async function fetchCaptureSnapshot(
	city: string,
	signal: AbortSignal | undefined,
	fetcher: typeof fetch = fetch,
	cache?: RequestCache,
	onHeaders?: (headers: Headers) => void,
): Promise<CaptureSnapshot> {
	const response = await fetcher(`/api/live?${new URLSearchParams({ city })}`, { signal, cache });
	if (!response.ok) throw new Error('Live capture unavailable');
	onHeaders?.(response.headers);
	const snapshot = captureSnapshotSchema.parse(await response.json());
	if (snapshot.city !== city) throw new Error('Live capture belongs to another city');
	return snapshot;
}

export async function fetchCaptureTripScope(
	city: string,
	scope: CaptureScope,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<CaptureTripReport> {
	const params = new URLSearchParams({ city, [scope.kind]: scope.id });
	const response = await fetcher(`/api/live-trips?${params}`, { signal });
	if (response.status === 503) {
		const retry = Number(response.headers.get('retry-after'));
		const body = await response.json().catch(() => null);
		if (body?.state === 'refreshing' && Number.isSafeInteger(retry) && retry > 0) {
			throw new CaptureScopeRefreshing(retry * 1000);
		}
	}
	if (!response.ok) throw new Error('Live trip update unavailable');
	const report = captureTripScopeSchema.parse(await response.json());
	if (report.city !== city || report.feed.family !== 'trip_updates') {
		throw new Error('Live trip update belongs to another scope');
	}
	return report;
}
