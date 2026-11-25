import type { StopDeparture, StopFile } from '#lib/v1/index.ts';
import type { StatusCode } from '#lib/v1/schemas/types.ts';
import { classifyDelay, type DelayBandCode } from '#lib/v1/live/statusBands.ts';

/** Capture predictions carry an exact status. Older reports only supply rounded minutes. */
export type DepartureStatus =
	| { readonly kind: 'known'; readonly bands: readonly DelayBandCode[] }
	| { readonly kind: 'unknown' };

export function departureStatus(
	minute: number | null | undefined,
	status?: StatusCode,
): DepartureStatus {
	if (status === 'unknown') return { kind: 'unknown' };
	if (status != null) return { kind: 'known', bands: [status] };
	if (minute == null || !Number.isInteger(minute)) return { kind: 'unknown' };
	// A rounded minute covers 60 seconds. Both cutoffs are whole minutes, six minutes apart,
	// so the endpoints never touch a cutoff and span at most two bands.
	const first = classifyDelay(60 * minute - 30);
	const last = classifyDelay(60 * minute + 30);
	if (first === 'unknown' || last === 'unknown') return { kind: 'unknown' };
	return { kind: 'known', bands: first === last ? [first] : [first, last] };
}

export interface DepartureStatusCopy {
	readonly bands: Readonly<Record<DelayBandCode, string>>;
	/** The rounded minute in words, for a minute that straddles a band limit. */
	readonly about: (minutes: number, early: boolean) => string;
}

/**
 * A status in words: the one band a minute certainly falls in, or, where the minute straddles a
 * limit, the rounded minute itself ("About 5 min late"), never two bands. Null without a minute.
 */
export function departureStatusText(
	minute: number | null | undefined,
	copy: DepartureStatusCopy,
	status = departureStatus(minute),
): string | null {
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
	readonly direction?: number | null;
	readonly startTime?: string | null;
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
				...(departure.start_time
					? { direction: departure.direction_id, startTime: departure.start_time }
					: {}),
				delayMin: departure.delay_min ?? null,
				status: departureStatus(departure.delay_min, departure.status),
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
