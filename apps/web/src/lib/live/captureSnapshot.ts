import { z } from 'zod';

const stamp = z.iso.datetime({ offset: true });
const sourceStamp = stamp.nullable();
const text = z.string().nullable();
const ordinal = z.int().nonnegative().nullable();
const reading = z.number().nullable();

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
});

export const captureSnapshotSchema = z.object({
	version: z.literal(1),
	city: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
	published_at: stamp,
	stable_vehicle_ids: z.boolean().nullable(),
	feeds: z.record(z.string(), feed),
	vehicle_positions: z.array(vehicle).nullable(),
	trip_updates: z.array(tripUpdate).nullable(),
	alerts: z.array(alert).nullable(),
});

export type CaptureSnapshot = z.infer<typeof captureSnapshotSchema>;
export type CaptureFamily = z.infer<typeof family>;
export type CaptureFeed = z.infer<typeof feed>;

export function feedState(feed: CaptureFeed | undefined, now: number) {
	if (!feed) return 'not_tracked';
	if (!feed.captured_at) return 'no_live_data';
	const captured = Date.parse(feed.captured_at);
	const observed = feed.source_at ? Date.parse(feed.source_at) : captured;
	const age = now - captured;
	const sourceAge = now - observed;
	if (age < -5_000 || sourceAge < -5_000) return 'unknown';
	const limit = feed.fresh_for_seconds * 1_000;
	if (age >= limit || sourceAge >= limit + feed.source_lag_seconds * 1_000) return 'stale';
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
