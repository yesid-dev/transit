import {
	captureAlerts,
	captureDepartures,
	captureNetwork,
	captureTrips,
	captureVehicles,
} from '#lib/live/captureProjection.ts';
import {
	captureSnapshotSchema,
	feedState,
	fetchCaptureSnapshot,
	fetchCaptureTripScope,
	type CaptureSnapshot,
} from '#lib/live/captureSnapshot.ts';
import { freshnessAgeSeconds } from '#lib/v1/freshness.ts';
import { DataHealthSchema } from '#lib/v1/schemas/data_health.ts';
import { getV1Runtime } from '#lib/v1/runtime.ts';
import { providerOf } from './r2.core';
import type { AdapterCtx } from './types';

// The store passes the same abort signal to the families in one poll.
// One city request supplies every family, and a new poll uses a new signal.
const byPoll = new WeakMap<AbortSignal, Map<string, Promise<CaptureSnapshot>>>();

async function read(ctx?: AdapterCtx) {
	const city = providerOf(ctx);
	if (ctx?.captureFetch) {
		const response = await ctx.captureFetch(city);
		if (!response?.ok) throw new Error('Live capture unavailable');
		const snapshot = captureSnapshotSchema.parse(await response.json());
		if (snapshot.city !== city) throw new Error('Live capture belongs to another city');
		return snapshot;
	}
	const signal = ctx?.signal;
	const load = () =>
		fetchCaptureSnapshot(city, signal, ctx?.fetch, ctx?.requestCache, ctx?.onResponseHeaders);
	if (!signal) return load();
	let cities = byPoll.get(signal);
	if (!cities) {
		cities = new Map();
		byPoll.set(signal, cities);
	}
	const prior = cities.get(city);
	if (prior) return prior;
	const pending = load();
	cities.set(city, pending);
	return pending;
}

const now = () => getV1Runtime().clock.serverNow;

async function scopedTrips(ctx?: AdapterCtx) {
	const requested = ctx?.tripScope;
	if (!requested) throw new Error('No selected live trip scope');
	const city = providerOf(ctx);
	if (requested.kind !== 'vehicle') {
		return fetchCaptureTripScope(city, requested, ctx?.signal, ctx?.fetch);
	}
	const snapshot = await read(ctx);
	const vehicle = snapshot.vehicle_positions?.find(
		(row) => (row.vehicle_id ?? row.id) === requested.id,
	);
	if (!vehicle?.trip_id) {
		const feed = Object.values(snapshot.feeds).find((feed) => feed.family === 'trip_updates');
		if (!vehicle || !feed?.captured_at) throw new Error('Vehicle trip unavailable');
		return { version: 2 as const, city, feed, trip_updates: [] };
	}
	return fetchCaptureTripScope(
		city,
		{ kind: 'trip', id: vehicle.trip_id },
		ctx?.signal,
		ctx?.fetch,
	);
}

export const livePort = {
	async vehicles(ctx?: AdapterCtx) {
		return captureVehicles(await read(ctx), now());
	},
	async trips(ctx?: AdapterCtx) {
		return captureTrips(await scopedTrips(ctx), now());
	},
	async stopDepartures(ctx?: AdapterCtx) {
		return captureDepartures(await scopedTrips(ctx), now());
	},
	async alerts(ctx?: AdapterCtx) {
		return captureAlerts(await read(ctx), now());
	},
	async network(ctx?: AdapterCtx) {
		return captureNetwork(await read(ctx), now());
	},
};

export const captureHealthPort = {
	async get(ctx?: AdapterCtx) {
		const snapshot = await read(ctx);
		const at = now();
		const feeds = Object.entries(snapshot.feeds);
		const untracked = (['vehicle_positions', 'trip_updates', 'alerts'] as const).filter(
			(family) => !feeds.some(([, input]) => input.family === family),
		);
		return DataHealthSchema.parse({
			generated_utc: snapshot.published_at,
			feeds: [
				...feeds.map(([feed, input]) => ({
					feed,
					status: feedState(input, at),
					age_s: freshnessAgeSeconds(input.source_at ?? input.captured_at, at, 5),
				})),
				...untracked.map((feed) => ({ feed, status: 'not_tracked', age_s: null })),
			],
			lanes: [],
		});
	},
};
