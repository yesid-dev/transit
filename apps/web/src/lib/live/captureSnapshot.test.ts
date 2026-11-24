import { describe, expect, it } from 'vitest';
import { captureDepartures, captureNetwork, captureVehicles } from './captureProjection';
import {
	captureSnapshotSchema,
	captureTripScopeSchema,
	feedState,
	fetchCaptureTripScope,
	CaptureScopeRefreshing,
} from './captureSnapshot';

const captured = '2026-11-23T16:30:00Z';
const now = Date.parse(captured);
const health = {
	captured_at: captured,
	source_at: captured,
	fresh_for_seconds: 60,
	source_lag_seconds: 0,
	read_failed: false,
};
const snapshot = captureSnapshotSchema.parse({
	version: 2,
	city: 'demo',
	published_at: captured,
	stable_vehicle_ids: true,
	feeds: {
		positions: { ...health, family: 'vehicle_positions' },
		predictions: { ...health, family: 'trip_updates' },
	},
	vehicle_positions: [
		{
			id: 'report',
			vehicle_id: '40001',
			trip_id: 'trip-1',
			start_date: null,
			start_time: null,
			route_id: '24',
			direction_id: null,
			latitude: 45,
			longitude: -73,
			bearing: null,
			speed_mps: null,
			stop_id: 'stop-1',
			stop_sequence: 1,
			status: 1,
			occupancy: 0,
			occupancy_percentage: null,
			observed_at: captured,
			delay: 0,
		},
	],
	alerts: null,
});
const scoped = captureTripScopeSchema.parse({
	version: 2,
	city: 'demo',
	feed: { ...health, family: 'trip_updates' },
	trip_updates: [
		{
			trip_id: 'trip-1',
			route_id: '24',
			direction_id: null,
			start_date: null,
			start_time: null,
			relationship: 0,
			delay: 0,
			stops: [
				{
					stop_id: 'stop-1',
					sequence: 1,
					arrival: null,
					departure: now / 1000 + 300,
					arrival_delay: null,
					departure_delay: 0,
					relationship: 0,
				},
			],
		},
	],
});

describe('capture-backed Live projection', () => {
	it('keeps no capture, unsupported capabilities and stale capture separate', () => {
		const feed = snapshot.feeds.positions;
		expect(feedState(undefined, now)).toBe('not_tracked');
		expect(feedState({ ...feed, captured_at: null }, now)).toBe('no_live_data');
		expect(feedState(feed, now + 59_999)).toBe('live');
		expect(feedState(feed, now + 60_000)).toBe('stale');
	});

	it('uses reported zero values and leaves an unsupported schedule denominator unknown', () => {
		const vehicles = captureVehicles(snapshot, now);
		expect(vehicles.vehicles[0]).toMatchObject({
			id: '40001',
			status: 'on_time',
			occupancy: 'empty',
			delay_min: 0,
		});
		expect(captureNetwork(snapshot, now)).toMatchObject({
			vehicles_in_service: 1,
			on_time_pct: 100,
			non_responding: null,
		});
		expect(
			captureNetwork(snapshot, now).delay_histogram?.find(({ lo_min }) => lo_min === 0),
		).toEqual({
			lo_min: 0,
			hi_min: 2,
			count: 1,
		});
		expect(captureDepartures(scoped, now).stops?.['stop-1']).toEqual([
			{
				route: '24',
				trip: 'trip-1',
				eta_utc: '2026-11-23T16:35:00.000Z',
				delay_min: 0,
				status: 'on_time',
			},
		]);
	});

	it('classifies vehicles and stop predictions before rounding and excludes unknown delays', () => {
		const vehicle = snapshot.vehicle_positions![0];
		const positions = [299, 300, -61, null].map((delay, index) => ({
			...vehicle,
			id: String(index),
			vehicle_id: String(index),
			delay,
		}));
		expect(captureNetwork({ ...snapshot, vehicle_positions: positions }, now)).toMatchObject({
			on_time_pct: 33,
			status_dist: { early: 1, on_time: 1, late: 1, unknown: 1 },
		});
		const report = scoped.trip_updates[0];
		const stop = report.stops[0];
		for (const [delay, status] of [
			[299, 'on_time'],
			[300, 'late'],
		] as const) {
			const result = captureDepartures(
				{
					...scoped,
					trip_updates: [{ ...report, stops: [{ ...stop, departure_delay: delay }] }],
				},
				now,
			);
			expect(result.stops?.['stop-1']?.[0]).toMatchObject({ delay_min: 5, status });
		}
	});

	it('distinguishes an ETag race from a missing scoped report', async () => {
		const scope = { kind: 'trip', id: 'trip-1' } as const;
		const refreshing = async () =>
			Response.json(
				{ state: 'refreshing' },
				{
					status: 503,
					headers: { 'retry-after': '1' },
				},
			);
		await expect(fetchCaptureTripScope('demo', scope, undefined, refreshing)).rejects.toMatchObject(
			{
				constructor: CaptureScopeRefreshing,
				retryAfterMs: 1000,
			},
		);
		const missing = async () => new Response(null, { status: 404 });
		await expect(fetchCaptureTripScope('demo', scope, undefined, missing)).rejects.toThrow(
			'unavailable',
		);
	});
});
