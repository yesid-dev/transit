import type { Receipt } from '#lib/v1/schemas/index.ts';
import { isoUtc } from '#lib/v1/schemas/types.ts';

/**
 * The receipt the page lays out, invisibly, while the real one loads: every section a published
 * day can show, at its fullest shape, so the real day takes the room it reserved and nothing
 * below it moves. A worst line and stop with long names, all five time-of-day rows, the service
 * split and four lines that did not report, the most a published day has listed so far.
 */
const LINE_NAME = 'Terminus centre-ville / Station Henri-Bourassa <> Parc industriel';
const STOP_NAME = 'Station Du Collège (du Collège / Décarie) / Terminus centre-ville';

const shift = (name: string) => ({
	shift: name,
	observation_count: 1_041_480,
	severe_count: 129_999,
	severe_pct: 12.5,
	avg_delay_min: -10.5,
});

export const receiptGauge: Receipt = {
	generated_utc: isoUtc().parse('1999-09-30T00:00:00Z'),
	date: '2027-09-30',
	methodology_version: 'receipt-3',
	otp_pct: 100,
	avg_delay_min: -10.5,
	severe_pct: 12.5,
	worst_route: { id: 'gauge-route', name: LINE_NAME, otp_delta_pts: -10.5 },
	worst_stop: { id: 'gauge-stop', name: STOP_NAME, avg_delay_min: 10.5 },
	affected_routes: 9_999,
	affected_stops: 99_999,
	alerts: 9_999,
	vehicles: 9_999,
	by_shift: ['am_peak', 'midday', 'pm_peak', 'evening', 'night'].map(shift),
	service_states: {
		scheduled_trip_days: 99_999,
		delivered_trip_days: 98_887,
		cancelled_trip_days: 8_888,
		silent_trip_days: 2_223,
		beyond_schedule_trip_days: 9_999,
		not_reported_route_count: 4,
		service_completeness_pct: 98.89,
		not_reported_routes: [1, 2, 3, 4].map((n) => ({
			id: `gauge-${n}`,
			name: LINE_NAME,
			scheduled_trip_days: 9_999,
		})),
	},
};
