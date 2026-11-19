import type {
	RepeatOffenderEntry,
	RepeatOffenderGrain,
	RepeatOffenders,
} from '#lib/v1/schemas/index.ts';
import { isoUtc } from '#lib/v1/schemas/types.ts';

/**
 * The record the page lays out, invisibly, while the real one loads: every region at its fullest
 * published shape, so the real record takes the room it reserved and nothing below it moves.
 * Each grain ranks one row more than the first page shows (the "show all" button appears) and
 * lists one not-ranked row more than the first page shows, each missing all three parts of the
 * rule. Names are long: a departure toward a long station name, on a line with the 65-character
 * name the home's rankings reserve (#1095). Every figure obeys the ranking's checks.
 */
const LINE_NAME = 'Terminus centre-ville / Station Henri-Bourassa <> Parc industriel';
const HEADSIGN = 'Station Henri-Bourassa';
const ROWS = 11;

function ranked(type: 'trip' | 'vehicle', windowDays: number, rank: number): RepeatOffenderEntry {
	return {
		rank,
		type,
		id: type === 'trip' ? `30563306${rank}` : `4${rank}000`,
		route: `gauge-${rank}`,
		route_name: LINE_NAME,
		route_short_name: '000',
		departure_time: '23:59:00',
		headsign: HEADSIGN,
		// 1,234,567 of 9,999,999 readings: 12.3 %, inside 12.2 % to 12.4 %.
		observation_count: 9_999_999,
		severe_count: 1_234_567,
		severe_pct: 12.3,
		wilson_lo: 87.6,
		wilson_hi: 87.8,
		recurrence_days: windowDays,
		observed_days: windowDays,
		window_days: windowDays,
		avg_delay_min: -10.5,
	};
}

function unranked(type: 'trip' | 'vehicle', index: number): RepeatOffenderEntry {
	return {
		type,
		id: type === 'trip' ? `30218194${index}` : `5${index}000`,
		route: `gauge-tray-${index}`,
		route_name: LINE_NAME,
		route_short_name: '000',
		departure_time: '23:59:00',
		headsign: HEADSIGN,
		// Below every floor: 29 readings, seen on 2 days, late on 1 (3.4 %, inside 3.3 % to 3.5 %).
		observation_count: 29,
		severe_count: 1,
		severe_pct: 3.4,
		wilson_lo: 96.5,
		wilson_hi: 96.7,
		recurrence_days: 1,
		observed_days: 2,
		avg_delay_min: -10.5,
	};
}

function grain(name: 'week' | 'month', windowDays: number, from: string, to: string) {
	// A retained day's grain also names its dates.
	const source: RepeatOffenderGrain & { date: string; window_end: string } = {
		grain: name,
		date: from,
		window_end: to,
		window_days: windowDays,
		entries: (['trip', 'vehicle'] as const).flatMap((type) =>
			Array.from({ length: ROWS }, (_, index) => ranked(type, windowDays, index + 1)),
		),
		tray: (['trip', 'vehicle'] as const).flatMap((type) =>
			Array.from({ length: ROWS }, (_, index) => unranked(type, index + 1)),
		),
		total_ranked_trips: 99_999,
		total_ranked_vehicles: 99_999,
		tray_total: 99_999,
	};
	return source;
}

export const offenderGauge: RepeatOffenders = {
	generated_utc: isoUtc().parse('1999-09-30T00:00:00Z'),
	methodology_version: 'reliability-2',
	// Periods that cross a year, so their dates print both years.
	by_grain: [
		grain('week', 7, '2026-12-28', '2027-01-03'),
		grain('month', 30, '2026-12-05', '2027-01-03'),
	],
};
