import { z } from 'zod';
import * as base from './generated/historic_route_reliability_index';
import { shownUnits, type MeasureSpec } from '../ranking/rank';

const percentSpec: MeasureSpec = {
	id: 'weekly_reliability',
	numerator: 'success',
	denominator: 'readings',
	denominator_from: 'entity',
	scale: [100n, 1n],
	precision: 0n,
	worse: 'lower',
	series: 'delay',
	floor_trips: null,
	floor_trips_of: 'readings',
	floor_units: null,
	floor_units_of: null,
	floor_service_days: false,
	pair: null,
};
function percentage(n: number, d: number, precision = 0): number {
	return (
		Number(shownUnits(BigInt(n), BigInt(d), percentSpec, { precision: BigInt(precision) })) /
		10 ** precision
	);
}
function validDate(value: string): boolean {
	const time = Date.parse(`${value}T00:00:00Z`);
	return (
		value.slice(0, 4) !== '0000' &&
		Number.isFinite(time) &&
		new Date(time).toISOString().slice(0, 10) === value
	);
}
function validInstant(value: string): boolean {
	return (
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		validDate(value.slice(0, 10)) &&
		new Date(value).toISOString().slice(0, 10) === value.slice(0, 10)
	);
}
const WeeklyRankingEntrySchema = base.WeeklyRankingEntrySchema.superRefine((row, ctx) => {
	const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
	if (
		!validDate(row.window_start) ||
		!validDate(row.window_end) ||
		Date.parse(row.window_end) - Date.parse(row.window_start) !== 6 * 86400000
	)
		fail('weekly ranking must span seven valid calendar dates');
	if (row.state === 'ranked') {
		if (row.numerator > row.denominator || row.pct !== percentage(row.numerator, row.denominator))
			fail('percentage must match ranked evidence');
		if (
			row.severe_pct != null &&
			row.severe_pct !== percentage(row.denominator - row.numerator, row.denominator, 1)
		)
			fail('severe share must match not-severe evidence');
	}
});
export const RouteReliabilityIndexSchema = base.RouteReliabilityIndexSchema.extend({
	weekly_routes: z.array(WeeklyRankingEntrySchema).nullable().optional(),
	weekly_stops: z.array(WeeklyRankingEntrySchema).nullable().optional(),
}).superRefine((index, ctx) => {
	const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
	if (!validInstant(index.generated_utc)) fail('invalid publication stamp');
	const p = index.published_utc,
		n = index.next_publish_utc;
	if ((p == null) !== (n == null)) fail('publication metadata must be supplied together');
	if (
		p != null &&
		n != null &&
		(!validInstant(p) ||
			!validInstant(n) ||
			Date.parse(n) <= Date.parse(p) ||
			Date.parse(n) - Date.parse(p) > 7 * 86400000)
	)
		fail('invalid historic publication interval');
	for (const [rows, stops] of [
		[index.weekly_routes, false],
		[index.weekly_stops, true],
	] as const) {
		if (!rows) continue;
		if (new Set(rows.map((row) => row.id)).size !== rows.length) fail('duplicate ranking identity');
		if (stops && rows.some((row) => row.state === 'ranked' && row.severe_pct == null))
			fail('ranked stops require their severe share');
	}
});
export type RouteReliabilityIndex = z.infer<typeof RouteReliabilityIndexSchema>;
