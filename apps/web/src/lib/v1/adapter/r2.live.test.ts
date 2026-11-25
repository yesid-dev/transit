import { afterEach, expect, it, vi } from 'vitest';
import { ManifestSchema } from '#lib/v1/schemas/manifest.ts';
import { r2Adapter } from './r2';
import { liveReader } from './index';

const timestamp = new Date().toISOString();

function liveBody(city: string) {
	const feed = (family: string) => ({
		family,
		captured_at: timestamp,
		source_at: timestamp,
		fresh_for_seconds: 60,
		source_lag_seconds: 0,
		read_failed: false,
	});
	return {
		version: 2,
		city,
		published_at: timestamp,
		stable_vehicle_ids: true,
		feeds: {
			vehicles: feed('vehicle_positions'),
			trips: feed('trip_updates'),
			alerts: feed('alerts'),
		},
		vehicle_positions: [],
		alerts: [],
	};
}

function manifest(provider: string) {
	return ManifestSchema.parse({
		provider,
		display_name: provider,
		bbox: [],
		attribution: '',
		dataset_version: 'demo',
		labels: {},
		surfaces: [],
		files: { live: { generated_utc: timestamp, ttl_s: 30 } },
	});
}

afterEach(() => vi.unstubAllGlobals());

it.each(['stm', 'octranspo'])(
	'shares one %s city snapshot and scopes the trip families',
	async (city) => {
		const body = liveBody(city);
		const request = vi.fn(async (url: RequestInfo | URL) =>
			Response.json(
				String(url).startsWith('/api/live-trips?')
					? { version: 2, city, feed: body.feeds.trips, trip_updates: [] }
					: body,
			),
		);
		vi.stubGlobal('fetch', request);
		const signal = new AbortController().signal;
		const onPollDelayMs = vi.fn();
		const ctx = {
			manifest: manifest(city),
			signal,
			onPollDelayMs,
			requestCache: 'reload' as const,
			tripScope: { kind: 'stop', id: 's' } as const,
		};
		const replies = await Promise.all([
			liveReader.vehicles(ctx),
			liveReader.trips(ctx),
			liveReader.stopDepartures(ctx),
			liveReader.alerts(ctx),
			liveReader.network(ctx),
		]);

		expect(request).toHaveBeenCalledWith(`/api/live?city=${city}`, {
			signal,
			cache: 'reload',
		});
		expect(request.mock.calls.filter(([url]) => url === `/api/live?city=${city}`)).toHaveLength(1);
		expect(request).toHaveBeenCalledWith(`/api/live-trips?city=${city}&stop=s`, { signal });
		expect(onPollDelayMs).toHaveBeenCalledWith(30_000);
		expect(replies[0]).toMatchObject({ vehicles: [] });
		expect(replies[4]).toMatchObject({ vehicles_in_service: 0, non_responding: null });
		await liveReader.vehicles({ ...ctx, signal: new AbortController().signal });
		expect(request.mock.calls.filter(([url]) => url === `/api/live?city=${city}`)).toHaveLength(2);
	},
);

it('rejects a live capture belonging to another city', async () => {
	const captureFetch = vi.fn(async () => Response.json(liveBody('other-city')));
	await expect(r2Adapter.live.vehicles({ providerId: 'stm', captureFetch })).rejects.toThrow(
		'another city',
	);
	expect(captureFetch).toHaveBeenCalledWith('stm');
});
