import type { NetworkFile, NetworkShift, TrendPoint } from './index';
import { liveOnTimeShare } from './live/onTimeShare';
import type { Receipt } from './schemas/receipts';

function receiptStatesView(states: Receipt['service_states']) {
	if (states == null) return null;
	return {
		scheduledTripDays: states.scheduled_trip_days ?? null,
		deliveredTripDays: states.delivered_trip_days ?? null,
		cancelledTripDays: states.cancelled_trip_days ?? null,
		silentTripDays: states.silent_trip_days ?? null,
		completenessPct: states.service_completeness_pct ?? null,
		notReportedRouteCount: states.not_reported_route_count ?? null,
		notReportedRoutes: Object.freeze(
			(states.not_reported_routes ?? []).map(
				(row) =>
					({
						id: row.id,
						name: row.name ?? null,
						scheduledTripDays: row.scheduled_trip_days ?? null,
					}) as const,
			),
		),
	} as const;
}

export function receiptReliabilityView(receipt: Receipt | null | undefined) {
	if (receipt == null) return null;
	return {
		onTimePct: receipt.otp_pct ?? null,
		meanDelayMin: receipt.avg_delay_min ?? null,
		severePct: receipt.severe_pct ?? null,
		affectedRoutes: receipt.affected_routes ?? null,
		affectedStops: receipt.affected_stops ?? null,
		alerts: receipt.alerts ?? null,
		vehicles: receipt.vehicles ?? null,
		worstRoute:
			receipt.worst_route == null
				? null
				: ({
						id: receipt.worst_route.id,
						name: receipt.worst_route.name ?? null,
						onTimeDeltaPts: receipt.worst_route.otp_delta_pts ?? null,
					} as const),
		worstStop:
			receipt.worst_stop == null
				? null
				: ({
						id: receipt.worst_stop.id,
						name: receipt.worst_stop.name ?? null,
						meanDelayMin: receipt.worst_stop.avg_delay_min ?? null,
					} as const),
		byShift: Object.freeze(
			(receipt.by_shift ?? []).map(
				(row) =>
					({
						shift: row.shift,
						severePct: row.severe_pct ?? null,
					}) as const,
			),
		),
		serviceStates: receiptStatesView(receipt.service_states),
	} as const;
}
export type ReceiptReliabilityView = NonNullable<ReturnType<typeof receiptReliabilityView>>;

const pointView = (point: TrendPoint) =>
	({
		date: point.date,
		onTimePct: point.otp_pct ?? null,
		meanDelayMin: point.avg_delay_min ?? null,
		p90Min: point.p90_min ?? null,
		cancellationPct: point.cancellation_rate ?? null,
		completenessPct: point.service_completeness_rate ?? null,
		vehicles: point.vehicles ?? null,
		occupancyMix: point.occupancy_mix ?? null,
	}) as const;
export type NetworkPointView = ReturnType<typeof pointView>;

const shiftView = (row: NetworkShift) =>
	({
		grain: row.grain,
		onTimePct: row.otp_pct ?? null,
		meanDelayMin: row.avg_delay_min ?? null,
		severePct: row.severe_pct ?? null,
	}) as const;
export type NetworkShiftView = ReturnType<typeof shiftView>;

export function networkReliabilityView(
	input: {
		live?: NetworkFile | null;
		points?: readonly TrendPoint[];
		byShift?: readonly NetworkShift[];
		byDaytype?: readonly NetworkShift[];
	} = {},
) {
	const live = input.live;
	return {
		live:
			live == null
				? null
				: ({
						onTime: liveOnTimeShare(live),
						coveragePct: live.coverage_pct ?? null,
						p50Min: live.delay_p50_min ?? null,
						p90Min: live.delay_p90_min ?? null,
						vehicles: live.vehicles_in_service,
						silentTrips: live.non_responding,
						statusDistribution: live.status_dist,
						occupancyMix: live.occupancy_mix ?? null,
						delayBuckets: live.delay_histogram ?? null,
						silentByLine: live.non_responding_by_route ?? null,
					} as const),
		points: (input.points ?? []).map(pointView) as readonly NetworkPointView[],
		byShift: (input.byShift ?? []).map(shiftView) as readonly NetworkShiftView[],
		byDaytype: (input.byDaytype ?? []).map(shiftView) as readonly NetworkShiftView[],
	} as const;
}
export type NetworkLiveView = NonNullable<ReturnType<typeof networkReliabilityView>['live']>;
