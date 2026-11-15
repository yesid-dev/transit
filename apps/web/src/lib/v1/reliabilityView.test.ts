import { expect, it } from 'vitest';
import { networkReliabilityView, receiptReliabilityView } from './reliabilityView';
import { ReceiptSchema, type Receipt } from './schemas/receipts';
import type { NetworkFile } from './index';

it('receipt projection preserves worst rows, shift order and independent service-state absence', () => {
	const receipt: Receipt = {
		date: '2026-01-01',
		generated_utc: ReceiptSchema.shape.generated_utc.parse('2026-01-02T00:00:00Z'),
		avg_delay_min: -2,
		severe_pct: NaN,
		worst_route: { id: '51', name: 'Line 51', otp_delta_pts: 0 },
		worst_stop: { id: 's1', name: null, avg_delay_min: -1 },
		by_shift: [
			{ shift: 'night', severe_pct: 5 },
			{ shift: 'am_peak', severe_pct: 5 },
			{ shift: 'unknown', severe_pct: null },
		],
		service_states: {
			scheduled_trip_days: 0,
			delivered_trip_days: 0,
			cancelled_trip_days: 2,
			service_completeness_pct: 0,
			not_reported_routes: [
				{ id: 'b', scheduled_trip_days: 0 },
				{ id: 'a', name: 'A' },
			],
		},
	};
	Object.freeze(receipt.worst_route);
	Object.freeze(receipt.worst_stop);
	receipt.by_shift!.forEach(Object.freeze);
	Object.freeze(receipt.by_shift);
	receipt.service_states!.not_reported_routes!.forEach(Object.freeze);
	Object.freeze(receipt.service_states!.not_reported_routes);
	Object.freeze(receipt.service_states);
	Object.freeze(receipt);
	const view = receiptReliabilityView(receipt)!;
	expect(view).toEqual({
		onTimePct: null,
		meanDelayMin: -2,
		severePct: NaN,
		affectedRoutes: null,
		affectedStops: null,
		alerts: null,
		vehicles: null,
		worstRoute: { id: '51', name: 'Line 51', onTimeDeltaPts: 0 },
		worstStop: { id: 's1', name: null, meanDelayMin: -1 },
		byShift: [
			{ shift: 'night', severePct: 5 },
			{ shift: 'am_peak', severePct: 5 },
			{ shift: 'unknown', severePct: null },
		],
		serviceStates: {
			scheduledTripDays: 0,
			deliveredTripDays: 0,
			cancelledTripDays: 2,
			silentTripDays: null,
			beyondScheduleTripDays: null,
			completenessPct: 0,
			notReportedRouteCount: null,
			notReportedRoutes: [
				{ id: 'b', name: null, scheduledTripDays: 0 },
				{ id: 'a', name: 'A', scheduledTripDays: null },
			],
		},
	});
	expect(view.worstRoute).not.toBe(receipt.worst_route);
	expect(view.worstStop).not.toBe(receipt.worst_stop);
	expect(view.byShift).not.toBe(receipt.by_shift);
	expect(view.serviceStates).not.toBe(receipt.service_states);
});

it('receipt projection keeps an absent receipt distinct from a receipt of measured zeros', () => {
	expect(receiptReliabilityView(null)).toBeNull();
	expect(receiptReliabilityView(undefined)).toBeNull();
	const receipt: Receipt = Object.freeze({
		date: '2026-01-01',
		generated_utc: ReceiptSchema.shape.generated_utc.parse('2026-01-02T00:00:00Z'),
		otp_pct: 0,
		avg_delay_min: 0,
		severe_pct: 0,
		affected_routes: 0,
		affected_stops: 0,
		alerts: 0,
		vehicles: 0,
	});
	expect(receiptReliabilityView(receipt)).toEqual({
		onTimePct: 0,
		meanDelayMin: 0,
		severePct: 0,
		affectedRoutes: 0,
		affectedStops: 0,
		alerts: 0,
		vehicles: 0,
		worstRoute: null,
		worstStop: null,
		byShift: [],
		serviceStates: null,
	});
});

it('keeps absent live data separate from measured zero', () => {
	expect(networkReliabilityView()).toEqual({ live: null, points: [], byShift: [], byDaytype: [] });
	const live = {
		on_time_pct: 0,
		coverage_pct: 0,
		delay_p50_min: 0,
		delay_p90_min: 0,
		vehicles_in_service: 0,
		non_responding: 0,
		status_dist: { early: 0, on_time: 0, late: 0, severe: 0, unknown: 0 },
		delay_histogram: [{ lo_min: -1, hi_min: 0, count: 2 }],
		non_responding_by_route: [{ route_id: '51', count: 0 }],
	} as NetworkFile;
	Object.freeze(live);
	expect(networkReliabilityView({ live }).live).toMatchObject({
		onTime: { kind: 'absent' },
		coveragePct: 0,
		p50Min: 0,
		p90Min: 0,
		vehicles: 0,
		silentTrips: 0,
	});
	const projected = networkReliabilityView({ live }).live!;
	expect(projected.statusDistribution).toBe(live.status_dist);
	expect(projected.delayBuckets).toBe(live.delay_histogram);
	expect(projected.silentByLine).toBe(live.non_responding_by_route);
	expect(projected.occupancyMix).toBeNull();
});

it('keeps ordered shifts separate from day types', () => {
	const shifts = Object.freeze([
		Object.freeze({ grain: 'night', otp_pct: null, severe_pct: 20, avg_delay_min: -1 }),
	]);
	const days = Object.freeze([Object.freeze({ grain: 'weekday', otp_pct: 0 })]);
	const view = networkReliabilityView({ byShift: shifts, byDaytype: days });
	expect(view.byShift).toEqual([
		{ grain: 'night', onTimePct: null, meanDelayMin: -1, severePct: 20 },
	]);
	expect(view.byDaytype).toEqual([
		{ grain: 'weekday', onTimePct: 0, meanDelayMin: null, severePct: null },
	]);
});

it('preserves ordered gaps, missing values, negatives and the retained mean/OTP invariant', () => {
	const points = Object.freeze([
		Object.freeze({
			date: '2026-01-01',
			otp_pct: 80,
			avg_delay_min: -1,
			p90_min: 0,
			vehicles: 0,
			cancellation_rate: 0,
			service_completeness_rate: NaN,
		}),
		Object.freeze({ date: '2026-01-03', otp_pct: null }),
	]);
	const view = networkReliabilityView({ points });
	expect(view.points.map((point) => point.date)).toEqual(['2026-01-01', '2026-01-03']);
	expect(view.points[0]).toMatchObject({ onTimePct: 80, meanDelayMin: -1, p90Min: 0 });
	expect(view.points[0]).toMatchObject({ vehicles: 0, cancellationPct: 0, completenessPct: NaN });
	expect(view.points[1]).toMatchObject({ onTimePct: null, meanDelayMin: null, vehicles: null });
	for (const point of view.points)
		if (point.meanDelayMin != null) expect(point.onTimePct).not.toBeNull();
	expect(points[0]).toMatchObject({ avg_delay_min: -1 });
});
