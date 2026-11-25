import { describe, expect, it } from 'vitest';
import { lineVehicleSentence } from '#lib/site/presenter.ts';
import {
	captureFixture,
	captureTrip,
	captureTripReport,
	captureVehicle,
} from '../../../../e2e/capture-fixture.ts';
import {
	lineSilentCount,
	lineVehicleRows,
	nextStopPredictions,
	vehicleCounts,
} from './lineLiveReadings.ts';

const now = Date.parse('2026-11-25T13:12:00Z');

describe('Line Live readings', () => {
	it('classifies raw delays at the inclusive Record thresholds and counts each reporting vehicle once', () => {
		const delays = [-61, -60, 300, 301, null];
		const positions = delays.map((delay, index) =>
			captureVehicle(now - 10_000, {
				vehicle_id: String(index),
				delay,
				route_id: '51',
			}),
		);
		const snapshot = captureFixture(now, {
			vehicle_positions: [
				...positions,
				captureVehicle(now - 20_000, { route_id: '51', vehicle_id: '0', delay: 1000 }),
				captureVehicle(now - 91_000, { route_id: '51', vehicle_id: 'old' }),
				captureVehicle(now, { route_id: '80', vehicle_id: 'other' }),
			],
		});
		const rows = lineVehicleRows(snapshot, '51', now)!;
		expect(rows.map(({ status }) => status)).toEqual([
			'early',
			'on_time',
			'on_time',
			'late',
			'unknown',
		]);
		expect(lineVehicleSentence(vehicleCounts(rows), 'en')).toBe(
			'vehicles are running on this line now: 1 early, 2 on time, 1 late, 1 with delay unknown.',
		);
		expect(lineVehicleSentence(vehicleCounts(rows), 'fr')).toBe(
			'véhicules circulent sur cette ligne en ce moment : 1 en avance, 2 à l’heure, 1 en retard, 1 au retard inconnu.',
		);
	});

	it('requires a current positions capture for an empty roster and both feeds for silent trips', () => {
		const snapshot = captureFixture(now, {
			vehicle_positions: [],
			non_responding_by_route: [{ route_id: '51', count: 2 }],
		});
		expect(lineVehicleRows(snapshot, '51', now)).toEqual([]);
		expect(lineSilentCount(snapshot, '51', now)).toBe(2);
		expect(lineSilentCount(snapshot, '24', now)).toBe(0);
		expect(lineSilentCount({ ...snapshot, non_responding_by_route: null }, '51', now)).toBeNull();
		snapshot.feeds.trip_updates!.read_failed = true;
		expect(lineSilentCount(snapshot, '51', now)).toBeNull();
		expect(lineVehicleRows(snapshot, '51', now)).toEqual([]);
		expect(lineVehicleRows(snapshot, '51', now + 91_000)).toBeNull();
		expect(lineVehicleRows(null, '51', now)).toBeNull();
	});

	it('selects the first future stop call with its own delay and excludes cancelled trips and skipped calls', () => {
		const call = (id: string, offset: number, delay: number | null) =>
			captureTrip(id, '51', [
				{ stop: 'snowdon', eta_utc: new Date(now + offset).toISOString(), delay_min: delay },
			]);
		const report = captureTripReport('stm', new Date(now).toISOString(), [
			call('later', 420_000, 2),
			call('next', 270_000, null),
			call('past', -1_000, 0),
			{ ...call('cancelled', 120_000, 0), relationship: 3 },
			{
				...call('skipped', 60_000, 0),
				stops: [{ ...call('skipped', 60_000, 0).stops[0], relationship: 1 }],
			},
		]);
		expect(nextStopPredictions(report, now).get('snowdon')).toEqual({
			trip: 'next',
			predictedAt: now + 270_000,
			delay: null,
			scheduledAt: null,
		});
		expect(nextStopPredictions(report, now + 91_000).size).toBe(0);
	});

	it('withholds a scheduled clock when the stop delay could be a trip-wide fallback', () => {
		const stop = { stop: 'snowdon', eta_utc: new Date(now + 300_000).toISOString(), delay_min: 2 };
		const predict = (tripDelay: number | null) =>
			nextStopPredictions(
				captureTripReport('stm', new Date(now).toISOString(), [
					captureTrip('next', '51', [stop], tripDelay),
				]),
				now,
			).get(stop.stop);
		expect(predict(120)?.scheduledAt).toBeNull();
		expect(predict(null)?.scheduledAt).toBe(now + 180_000);
	});
});
