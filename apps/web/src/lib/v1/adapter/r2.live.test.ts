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
		version: 1,
		city,
		published_at: timestamp,
		stable_vehicle_ids: true,
		feeds: {
			vehicles: feed('vehicle_positions'),
			trips: feed('trip_updates'),
			alerts: feed('alerts'),
		},
		vehicle_positions: [],
		trip_updates: [],
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
	'shares one %s snapshot across every Live family in a poll',
	async (city) => {
		const request = vi.fn(async () => Response.json(liveBody(city)));
		vi.stubGlobal('fetch', request);
		const signal = new AbortController().signal;
		const onPollDelayMs = vi.fn();
		const ctx = {
			manifest: manifest(city),
			signal,
			onPollDelayMs,
			requestCache: 'reload' as const,
		};
		const replies = await Promise.all([
			liveReader.vehicles(ctx),
			liveReader.trips(ctx),
			liveReader.stopDepartures(ctx),
			liveReader.alerts(ctx),
			liveReader.network(ctx),
		]);

		expect(request).toHaveBeenCalledExactlyOnceWith(`/api/live?city=${city}`, {
			signal,
			cache: 'reload',
		});
		expect(onPollDelayMs).toHaveBeenCalledWith(30_000);
		expect(replies[0]).toMatchObject({ vehicles: [] });
		expect(replies[4]).toMatchObject({ vehicles_in_service: 0, non_responding: null });
		await liveReader.vehicles({ ...ctx, signal: new AbortController().signal });
		expect(request).toHaveBeenCalledTimes(2);
	},
);

it('reads SSR health through the binding and rejects data for another city', async () => {
	const captureFetch = vi.fn(async (city: string) => Response.json(liveBody(city)));
	const ctx = { providerId: 'stm', captureFetch };
	await expect(r2Adapter.dataHealth.get(ctx)).resolves.toMatchObject({
		feeds: expect.arrayContaining([
			{ feed: 'vehicles', status: 'live', age_s: expect.any(Number) },
		]),
		lanes: [],
	});
	expect(captureFetch).toHaveBeenCalledWith('stm');
	captureFetch.mockResolvedValueOnce(Response.json(liveBody('other-city')));
	await expect(r2Adapter.live.vehicles(ctx)).rejects.toThrow('another city');
});
