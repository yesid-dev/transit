import type { StopDeparture, StopFile } from '#lib/v1/index.ts';
import { LIVE_STATUS_BANDS, type DelayBandCode } from '#lib/v1/live/statusBands.ts';

/**
 * A departure's status from its published minute. The departures file carries only
 * `delay_min`, the trip's average predicted delay rounded half away from zero
 * (`_delay_min` in apps/db builders/_helpers.py), and no status of its own. A rounded minute
 * covers 60 seconds, so where those seconds straddle a band threshold both bands are named
 * (1 min is on time or late), never one guessed from the rounded value.
 */
export type DepartureStatus =
	| { readonly kind: 'known'; readonly bands: readonly DelayBandCode[] }
	| { readonly kind: 'unknown' };

const BAND_ORDER = Object.keys(LIVE_STATUS_BANDS) as DelayBandCode[];

export function departureStatus(minute: number | null | undefined): DepartureStatus {
	if (minute == null || !Number.isInteger(minute)) return { kind: 'unknown' };
	// round_half_away(s / 60) = m holds for s in [60m − 30, 60m + 30), mirrored below zero and
	// open at both ends for m = 0. The thresholds are whole minutes, so no end touches one.
	const low = 60 * minute - 30;
	const high = 60 * minute + 30;
	const bands = BAND_ORDER.filter((code) => {
		const { fromS, belowS } = LIVE_STATUS_BANDS[code];
		return (fromS == null || fromS < high) && (belowS == null || belowS > low);
	});
	return { kind: 'known', bands };
}

export interface DepartureStatusCopy {
	readonly bands: Readonly<Record<DelayBandCode, string>>;
	/** The rounded minute in words, for a minute that straddles a band limit. */
	readonly about: (minutes: number, early: boolean) => string;
}

/**
 * A status in words: the one band a minute certainly falls in, or, where the minute straddles a
 * limit, the rounded minute itself ("About 1 min late"), never two bands. Null without a minute.
 */
export function departureStatusText(
	minute: number | null | undefined,
	copy: DepartureStatusCopy,
): string | null {
	const status = departureStatus(minute);
	if (status.kind === 'unknown') return null;
	if (status.bands.length === 1) return copy.bands[status.bands[0]!];
	return copy.about(Math.abs(minute!), minute! < 0);
}

export interface StopPredictionRow {
	/** Null when the published time cannot be read. */
	readonly etaUtc: string | null;
	readonly trip: string | null;
	readonly delayMin: number | null;
	readonly status: DepartureStatus;
}

export interface StopPredictionGroup {
	/** Null for predictions the report does not attach to a line. */
	readonly line: string | null;
	/** This line's destinations in the stop's schedule, in first-listed order; none when unpublished. */
	readonly destinations: readonly string[];
	readonly rows: readonly StopPredictionRow[];
}

export type StopLiveView =
	| { readonly kind: 'pending' }
	| { readonly kind: 'no-capability' }
	| { readonly kind: 'no-service' }
	| { readonly kind: 'stale-none' }
	| { readonly kind: 'none' }
	| {
			readonly kind: 'list';
			readonly groups: readonly StopPredictionGroup[];
			readonly total: number;
	  };

export type StopLiveOrder = 'soonest' | 'line';

export interface StopLiveInput {
	/** This stop's predictions in the loaded report; null before a report is loaded. */
	readonly departures: readonly StopDeparture[] | null;
	/** The loaded report is out of date. */
	readonly reportStale: boolean;
	/** Lines the stop file says serve the stop; null while that file is unavailable. */
	readonly servedLines: readonly string[] | null;
	readonly scheduled: StopFile['scheduled'] | null;
	/** The provider declares no live data for this line (the line page's capability seam). */
	readonly lineHasNoLiveData: (line: string) => boolean;
	/** The public line number, for ordering by line. */
	readonly lineNumber: (line: string) => string;
	readonly order: StopLiveOrder;
}

const collator = new Intl.Collator('en', { numeric: true });

/** The stop's Live now predictions, or the one honest reason there are none to show. */
export function presentStopLive(input: StopLiveInput): StopLiveView {
	const { departures, servedLines } = input;
	if (departures == null) return { kind: 'pending' };
	if (departures.length === 0) {
		if (servedLines != null && servedLines.length === 0) return { kind: 'no-service' };
		if (servedLines != null && servedLines.every(input.lineHasNoLiveData))
			return { kind: 'no-capability' };
		return { kind: input.reportStale ? 'stale-none' : 'none' };
	}

	const destinations = new Map<string, string[]>();
	for (const entry of input.scheduled ?? []) {
		const headsign = entry.headsign?.trim();
		if (!headsign) continue;
		const list = destinations.get(entry.route) ?? [];
		if (!list.includes(headsign)) list.push(headsign);
		destinations.set(entry.route, list);
	}

	const byLine = new Map<string | null, { row: StopPredictionRow; ms: number }[]>();
	for (const departure of departures) {
		const ms = Date.parse(departure.eta_utc);
		const line = departure.route ?? null;
		const rows = byLine.get(line) ?? [];
		rows.push({
			ms: Number.isFinite(ms) ? ms : Infinity,
			row: {
				etaUtc: Number.isFinite(ms) ? departure.eta_utc : null,
				trip: departure.trip ?? null,
				delayMin: departure.delay_min ?? null,
				status: departureStatus(departure.delay_min),
			},
		});
		byLine.set(line, rows);
	}

	const groups = [...byLine].map(([line, rows]) => {
		rows.sort((a, b) => a.ms - b.ms);
		return {
			soonest: rows[0]!.ms,
			group: {
				line,
				destinations: line == null ? [] : (destinations.get(line) ?? []),
				rows: rows.map(({ row }) => row),
			},
		};
	});
	groups.sort((a, b) => {
		// Predictions without a line come last in either order.
		if (a.group.line == null || b.group.line == null) return a.group.line == null ? 1 : -1;
		if (input.order === 'line')
			return collator.compare(input.lineNumber(a.group.line), input.lineNumber(b.group.line));
		return a.soonest === b.soonest ? 0 : a.soonest - b.soonest;
	});
	return { kind: 'list', groups: groups.map(({ group }) => group), total: departures.length };
}
