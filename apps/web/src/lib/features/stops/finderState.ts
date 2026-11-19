import { fromSearchParams } from '#lib/filters/index.ts';
import { foldSearchText, tokenMatchScore } from '#lib/search/normalize.ts';
import { nearestStops, type LatLon } from '#lib/components/map/nearbyStops.ts';
import type { RouteFile } from '#lib/v1/schemas/route.ts';
import type { StopIndexEntry } from '#lib/v1/schemas/stops_index.ts';

/**
 * The Stops finder's state and rows, kept out of the component so the URL contract, the orders
 * and the record links can be checked from small seeds. The finder lists every published stop:
 * nothing is capped silently, and every narrowing has a count and a way back.
 */

/** Twenty rows at first, then explicit twenty-row increments: the last one states its real size. */
export const FINDER_PAGE_SIZE = 20;

/** "Stops near me" lists what is within walking distance, nearest first. */
export const NEAR_RADIUS_M = 1_000;

export type FinderOrder = 'default' | 'late';

/** Everything the finder keeps in the URL, so Back and a refresh restore the same view. */
export interface FinderState {
	readonly query: string;
	/** The line whose stop list is shown, along the line. */
	readonly route: string | null;
	readonly order: FinderOrder;
	/** The previewed stop. */
	readonly stop: string | null;
	readonly shown: number;
}

function text(value: string | null): string {
	return (value ?? '')
		.replace(/[\p{Cc}]+/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim()
		.slice(0, 80);
}

function positiveIncrement(value: string | null): number | null {
	if (!value || !/^\d{1,6}$/u.test(value)) return null;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
	// Only increments the Show more control can write are honoured.
	return parsed % FINDER_PAGE_SIZE === 0 ? parsed : null;
}

/** The finder's view from the URL; a value the controls cannot write falls back to its default. */
export function parseFinderState(params: URLSearchParams): FinderState {
	// The line keeps the shared filter codec's `route` axis, so links written before stay valid.
	const route = [...fromSearchParams(params).routes][0] ?? null;
	const stop = params.get('stop');
	return {
		query: text(params.get('q')),
		route,
		order: params.get('sort') === 'late' ? 'late' : 'default',
		// IDs are opaque published values: the view checks membership, links URI-encode them.
		stop: stop || null,
		shown: positiveIncrement(params.get('shown')) ?? FINDER_PAGE_SIZE,
	};
}

/** The parameters to mirror; defaults stay absent so a plain visit keeps a clean URL. */
export function finderSearchParams(state: FinderState): Record<string, string | null> {
	return {
		q: state.query || null,
		route: state.route,
		sort: state.order === 'late' ? 'late' : null,
		stop: state.stop,
		shown: state.shown > FINDER_PAGE_SIZE ? String(state.shown) : null,
	};
}

/** How many rows Show more adds; the last increment states its real size. */
export function nextPageSize(shown: number, matching: number): number {
	return Math.min(FINDER_PAGE_SIZE, Math.max(0, matching - shown));
}

/** One row: the stop, the direction it was listed under on a line, and its distance when near. */
export interface FinderRow {
	readonly key: string;
	readonly stop: StopIndexEntry;
	/** The direction's own published name; an unnamed direction gets none (never "Direction 0"). */
	readonly towards: string | null;
	readonly distanceM: number | null;
}

const row = (
	stop: StopIndexEntry,
	towards: string | null = null,
	distanceM: number | null = null,
) => ({
	key: towards == null ? stop.id : `${stop.id}|${towards}`,
	stop,
	towards,
	distanceM,
});

/**
 * The stop page's Live now capability rule for a row: every line serving the stop is one its
 * provider declares without live data. A stop with no known lines makes no such claim.
 */
export function stopHasNoLiveData(
	stop: Pick<StopIndexEntry, 'routes'>,
	lineHasNoLiveData: (line: string) => boolean,
): boolean {
	const lines = stop.routes ?? [];
	return lines.length > 0 && lines.every(lineHasNoLiveData);
}

const matchesQuery = (stop: StopIndexEntry, folded: string) =>
	!folded || tokenMatchScore([stop.name, stop.code, stop.id], folded) != null;

/**
 * The network's stops for a query: every stop by name when there is none, otherwise every match,
 * best first, then by name. Nothing is merged or dropped, so the counts are the published ones.
 */
export function networkRows(
	stops: readonly StopIndexEntry[],
	query: string,
	compare: (a: string, b: string) => number,
): FinderRow[] {
	const folded = foldSearchText(query);
	const byName = (a: StopIndexEntry, b: StopIndexEntry) =>
		compare(a.name, b.name) || compare(a.code ?? a.id, b.code ?? b.id);
	if (!folded) return [...stops].sort(byName).map((stop) => row(stop));
	return stops
		.map((stop) => ({ stop, score: tokenMatchScore([stop.name, stop.code, stop.id], folded) }))
		.filter((match): match is { stop: StopIndexEntry; score: number } => match.score != null)
		.sort((a, b) => a.score - b.score || byName(a.stop, b.stop))
		.map((match) => row(match.stop));
}

/**
 * A line's published stop list, direction by direction in travel order, each row naming the
 * direction it was listed under. A stop the network index lacks keeps the line's own name.
 */
export function lineRows(
	route: Pick<RouteFile, 'directions'> | null | undefined,
	stops: readonly StopIndexEntry[],
	query: string,
): FinderRow[] {
	const folded = foldSearchText(query);
	const byId = new Map(stops.map((stop) => [stop.id, stop]));
	const rows: FinderRow[] = [];
	const seen = new Set<string>();
	for (const direction of route?.directions ?? []) {
		const towards = direction.headsign?.trim() || null;
		for (const listed of [...(direction.stops ?? [])].sort((a, b) => a.seq - b.seq)) {
			const stop = byId.get(listed.id) ?? {
				id: listed.id,
				name: listed.name ?? listed.id,
				lat: Number.NaN,
				lon: Number.NaN,
			};
			const next = row(stop, towards);
			if (seen.has(next.key) || !matchesQuery(stop, folded)) continue;
			seen.add(next.key);
			rows.push(next);
		}
	}
	return rows;
}

/** The stops within walking distance of a place, nearest first, narrowed by the typed filter. */
export function nearRows(
	origin: LatLon,
	stops: readonly StopIndexEntry[],
	query: string,
): FinderRow[] {
	const folded = foldSearchText(query);
	const candidates = stops.filter(
		(stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon) && matchesQuery(stop, folded),
	);
	return nearestStops(origin, candidates, candidates.length, NEAR_RADIUS_M).map((stop) =>
		row(stop, null, stop.distanceM),
	);
}

/**
 * Published order: the publisher's ranked stops first, in the order it supplied (never re-sorted),
 * then every other row in its own order. A stop the publication does not mention stays listed.
 */
export function publishedOrderRows(
	rows: readonly FinderRow[],
	rankedIds: readonly string[],
): FinderRow[] {
	const position = new Map(rankedIds.map((id, index) => [id, index]));
	const ranked = rows
		.filter((candidate) => position.has(candidate.stop.id))
		.sort((a, b) => position.get(a.stop.id)! - position.get(b.stop.id)!);
	return [...ranked, ...rows.filter((candidate) => !position.has(candidate.stop.id))];
}

export interface FinderHrefInput {
	/** The finder's own URL: its origin, locale prefix and unrelated parameters are kept. */
	readonly base: URL;
	/** The destination's localized path, already resolved for the reader's locale. */
	readonly path: string;
	readonly providerId: string;
}

const FINDER_ONLY_PARAMS = ['q', 'route', 'sort', 'stop', 'shown', 'tab', 'from', 'to'] as const;

/**
 * A stop's Record link: the reader's locale and provider stay, the finder's own view goes, and it
 * carries the week the row showed, so the record opens on the same seven days.
 */
export function stopRecordHref(
	input: FinderHrefInput & {
		readonly window?: { readonly from: string; readonly to: string } | null;
	},
): string {
	const next = new URL(input.base.href);
	next.pathname = new URL(input.path, input.base.origin).pathname;
	for (const key of FINDER_ONLY_PARAMS) next.searchParams.delete(key);
	next.searchParams.set('provider', input.providerId);
	if (input.window) {
		next.searchParams.set('from', input.window.from);
		next.searchParams.set('to', input.window.to);
	}
	return next.pathname + next.search;
}

/** A map link: the requested path and its own filter, with the reader's provider. */
export function providerHref(input: FinderHrefInput): string {
	const next = new URL(input.path, input.base.origin);
	next.searchParams.set('provider', input.providerId);
	return next.pathname + next.search;
}
