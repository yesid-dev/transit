import { stopDisplayName, lineLabel, transitNameAliases } from '#lib/site/transitDisplay.ts';
import type { Locale } from '#lib/i18n/copy.ts';
import type { NameSeparators } from '#lib/v1/schemas/providers.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import type { RouteIndexEntry, StopIndexEntry, Vehicle } from '#lib/v1/schemas/index.ts';
import { FILTER_SEARCH_PARAM_KEYS, fromSearchParams, toSearchString } from '#lib/filters/index.ts';
import type { GeocodePrecision, GeocodeSuggestion } from '#lib/geocode/types.ts';
import type { BilingualLabel } from '#lib/content/nav.ts';
import { routeFor } from '#lib/nav/index.ts';
import { dedupeBy, foldSearchText, tokenMatchScore } from '#lib/search/normalize.ts';
import {
	routeModeKey,
	stopGroupKey,
	stopModeKey,
	type TransitModeKey,
} from '#lib/search/stopMode.ts';
import { setMapFocusSearchParams, type MapFocusKind } from '#lib/search/mapFocus.ts';
import {
	copyNearTargetSearchParams,
	mapNearId,
	setNearTargetSearchParams,
} from '#lib/search/mapNear.ts';

export const SEARCH_KINDS = ['route', 'stop', 'vehicle', 'page'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export type ChromeSearchKind = SearchKind | 'address';
export type SearchScope = SearchKind | 'all';

export function searchScope(value: string | null): SearchScope {
	return SEARCH_KINDS.find((kind) => kind === value) ?? 'all';
}

/** Single-digit line numbers are searchable. */
export function searchQueryState(query: string): 'empty' | 'short' | 'ready' {
	if (!query.trim()) return 'empty';
	const folded = foldSearchText(query);
	return /\d/.test(folded) || (folded.length >= 2 && /\p{L}/u.test(folded)) ? 'ready' : 'short';
}

export type ChromeSearchScope = 'route' | 'stop' | 'map' | 'all';

/** A page of this site: found by its name in either language, or by a term it explains. */
export interface SitePage {
	readonly href: string;
	readonly label: BilingualLabel;
	/** The menu group it sits in, when it has one. */
	readonly group: BilingualLabel | null;
	readonly words: readonly string[];
}

type SearchVehicle = Pick<Vehicle, 'id' | 'route'>;

export interface SearchSources {
	readonly locale?: Locale;
	readonly nameSeparators?: NameSeparators;
	readonly routes?: readonly RouteIndexEntry[] | null;
	readonly stops?: readonly StopIndexEntry[] | null;
	readonly vehicles?: readonly SearchVehicle[] | null;
	readonly pages?: readonly SitePage[] | null;
}

export interface PageSearchRequest {
	readonly query: string;
	readonly surface: 'page';
	readonly modes?: ReadonlySet<TransitModeKey>;
}
export interface PageSearchResults {
	readonly query: string;
	readonly routes: RouteIndexEntry[];
	readonly stops: StopIndexEntry[];
	readonly vehicles: SearchVehicle[];
	readonly pages: SitePage[];
}
/** The header list: the page decides the order (`scope`), never what is searched. */
export interface ListSearchRequest {
	readonly query: string;
	readonly surface: 'list';
	readonly scope?: ChromeSearchScope;
	/** Results on the page can reveal more rows without changing their ranking. */
	readonly rows?: number;
}
/** One row. Labels are the record's own names; callers add every word. */
export interface SearchHit {
	readonly kind: ChromeSearchKind;
	readonly id: string;
	readonly label: string;
	readonly code?: string | null;
	readonly name?: string | null;
	readonly mode?: TransitModeKey | null;
	readonly line?: string | null;
	readonly lat?: number;
	readonly lon?: number;
	readonly precision?: GeocodePrecision;
}
/** What a result link needs: a hit, or a map target named by kind and id. */
export type SearchTarget = Pick<SearchHit, 'kind' | 'id'> &
	Partial<Pick<SearchHit, 'label' | 'lat' | 'lon' | 'precision'>>;
export interface SearchGroup {
	readonly kind: ChromeSearchKind;
	/** Every match, not only the rows shown. */
	readonly total: number;
	readonly hits: readonly SearchHit[];
}
export interface SearchList {
	readonly query: string;
	readonly groups: readonly SearchGroup[];
	/** Lines, stops and vehicles matched: the count /search shows. */
	readonly total: number;
	/** The first row matches the query exactly. */
	readonly exact: boolean;
	/** The lines or stops index has not arrived, so no answer is final yet. */
	readonly pending: boolean;
	readonly indexSettled?: boolean;
	readonly vehiclesNotTracked?: boolean;
	/** Which of those indexes: never counted as zero. */
	readonly unsearched: readonly ('route' | 'stop' | 'vehicle')[];
}
interface Candidate<T> {
	value: T;
	score: number;
}
interface Candidates {
	routes: Candidate<RouteIndexEntry>[];
	stops: Candidate<StopIndexEntry>[];
	vehicles: SearchVehicle[];
}

/** An internal id the rider never reads: matched only exactly, after every public match. */
const INTERNAL_ID_SCORE = 4;
function scoredCandidates<T>(
	values: readonly T[],
	query: string,
	fields: (value: T) => readonly (string | null | undefined)[],
	internalId: (value: T) => string | null = () => null,
): Candidate<T>[] {
	return values
		.map((value) => ({
			value,
			score:
				tokenMatchScore(fields(value), query) ??
				(foldSearchText(internalId(value)) === query ? INTERNAL_ID_SCORE : null),
		}))
		.filter((match): match is Candidate<T> => match.score != null);
}
function byScore(a: { score: number }, b: { score: number }): number {
	return a.score - b.score;
}

function candidates(request: PageSearchRequest, sources: SearchSources, query: string): Candidates {
	const modes = request.modes?.size ? request.modes : null;
	const keepsMode = (mode: TransitModeKey | null): boolean => !modes || (!!mode && modes.has(mode));
	const routes = scoredCandidates(
		sources.routes ?? [],
		query,
		(route) => [
			route.short || route.id,
			route.long,
			...transitNameAliases(route.long, sources.nameSeparators),
		],
		(route) => route.id,
	)
		.filter(({ value }) => keepsMode(routeModeKey(value.type)))
		.sort(byScore);
	const stopMatches = scoredCandidates(
		sources.stops ?? [],
		query,
		(stop) => [stop.code, stop.name],
		(stop) => stop.id,
	).sort(byScore);
	// A stop's representative is chosen before the mode filter.
	const stops = dedupeBy(stopMatches, ({ value }) => stopGroupKey(value)).filter(({ value }) =>
		keepsMode(stopModeKey(value)),
	);
	const numberQuery = /^\d+(?: \d+)*$/.test(query) ? query.replaceAll(' ', '') : null;
	const vehicles = keepsMode('bus')
		? (sources.vehicles ?? []).filter((vehicle) => {
				const id = foldSearchText(vehicle.id);
				return id === query || (numberQuery !== null && id.replaceAll(' ', '') === numberQuery);
			})
		: [];
	return { routes, stops, vehicles };
}

function matchingPages(pages: SearchSources['pages'], query: string) {
	return query
		? scoredCandidates(pages ?? [], query, (page) => [
				page.label.en,
				page.label.fr,
				...page.words,
			]).sort(byScore)
		: [];
}

const LIST_ROWS = {
	route: { route: 6, stop: 2 },
	stop: { stop: 6, route: 2 },
	all: { route: 4, stop: 4 },
} as const;
function searchList(
	request: ListSearchRequest,
	sources: SearchSources,
	query: string,
	matches: Candidates,
): SearchList {
	const lead = request.scope === 'route' || request.scope === 'stop' ? request.scope : 'all';
	const rows = LIST_ROWS[lead];
	const pages = matchingPages(sources.pages, query);
	const directory = createLineDirectory(sources.routes ?? null, {
		line: (id) => id,
		locale: sources.locale,
		nameSeparators: sources.nameSeparators,
	});
	const lines: SearchGroup = {
		kind: 'route',
		total: matches.routes.length,
		hits: matches.routes.slice(0, request.rows ?? rows.route).map(({ value }) => {
			const line = directory.name(value.id);
			return {
				kind: 'route',
				id: value.id,
				label: line.label,
				code: line.number,
				name: line.name,
				mode: routeModeKey(value.type),
			};
		}),
	};
	const stops: SearchGroup = {
		kind: 'stop',
		total: matches.stops.length,
		hits: matches.stops.slice(0, request.rows ?? rows.stop).map(({ value }) => ({
			kind: 'stop',
			id: value.id,
			label: stopDisplayName(value.name),
			code: value.code ?? null,
		})),
	};
	const vehicles: SearchGroup = {
		kind: 'vehicle',
		total: matches.vehicles.length,
		hits: matches.vehicles.slice(0, request.rows ?? 1).map((vehicle) => ({
			kind: 'vehicle',
			id: vehicle.id,
			label: vehicle.id,
			line: vehicle.route ? lineLabel(vehicle.route, sources.routes ?? []) : null,
		})),
	};
	const pageGroup: SearchGroup = {
		kind: 'page',
		total: pages.length,
		hits: pages.slice(0, request.rows ?? 2).map(({ value }) => ({
			kind: 'page',
			id: value.href,
			label: value.label[sources.locale ?? 'en'],
		})),
	};
	const groups = [...(lead === 'stop' ? [stops, lines] : [lines, stops]), vehicles, pageGroup];
	const shown = groups.filter((group) => group.hits.length > 0);
	const first = shown[0]?.kind;
	const availability = {
		route: sources.routes,
		stop: sources.stops,
		vehicle: sources.vehicles === undefined ? [] : sources.vehicles,
	};
	const unsearched = (['route', 'stop', 'vehicle'] as const).filter(
		(kind) => availability[kind] == null,
	);
	return {
		query,
		groups: shown,
		total: groups.reduce((total, group) => total + group.total, 0),
		exact:
			first === 'vehicle' ||
			(first === 'route' && matches.routes[0]!.score === 0) ||
			(first === 'stop' && matches.stops[0]!.score === 0) ||
			(first === 'page' && pages[0]!.score === 0),
		pending: unsearched.length > 0,
		unsearched,
	};
}

export function searchTransit(
	request: PageSearchRequest,
	sources: SearchSources,
): PageSearchResults;
export function searchTransit(request: ListSearchRequest, sources: SearchSources): SearchList;
export function searchTransit(
	request: PageSearchRequest | ListSearchRequest,
	sources: SearchSources,
): PageSearchResults | SearchList {
	const query = foldSearchText(request.query);
	const matches = query
		? candidates(request.surface === 'list' ? { query, surface: 'page' } : request, sources, query)
		: { routes: [], stops: [], vehicles: [] };
	if (request.surface === 'list') return searchList(request, sources, query, matches);
	return {
		query,
		routes: matches.routes.map(({ value }) => value),
		stops: matches.stops.map(({ value }) => value),
		vehicles: matches.vehicles,
		pages: matchingPages(sources.pages, query).map(({ value }) => value),
	};
}

/** The addresses the reader asked for, last and two at most; never part of the /search count. */
export function withAddresses(
	list: SearchList,
	addresses: readonly GeocodeSuggestion[],
): SearchList {
	const groups = list.groups.filter((group) => group.kind !== 'address');
	if (!addresses.length) return { ...list, groups };
	const hits = addressHits(addresses).slice(0, 2);
	return { ...list, groups: [...groups, { kind: 'address', total: addresses.length, hits }] };
}

/** Address rows: each opens the map's near target. */
export function addressHits(addresses: readonly GeocodeSuggestion[]): SearchHit[] {
	return addresses.map((address) => ({
		kind: 'address',
		id: addressResultId(address),
		label: address.label,
		lat: address.lat,
		lon: address.lon,
		precision: address.precision,
	}));
}

/** Text worth sending to the geocoder: three characters or more, and not coordinates. */
export function canSearchAddresses(query: string): boolean {
	const text = query.trim();
	return text.length >= 3 && !/^-?\d+(?:\.\d+)?\s*[, ]\s*-?\d*(?:\.\d*)?$/.test(text);
}

export function scopeForPath(delocalizedPath: string): ChromeSearchScope {
	if (delocalizedPath === '/lines' || delocalizedPath.startsWith('/lines/')) return 'route';
	if (delocalizedPath === '/stops' || delocalizedPath.startsWith('/stop/')) return 'stop';
	if (delocalizedPath === '/map') return 'map';
	return 'all';
}

/** The search page with this query: where "See all" and Enter without a highlight lead. */
export function searchPageHref(query: string, kind: SearchScope = 'all'): string {
	const params = new URLSearchParams({ q: query });
	if (kind !== 'all') params.set('kind', kind);
	return `/search?${params}`;
}

/** Where the reader searches from: the delocalized path and its query. */
export interface SearchOrigin {
	readonly path: string;
	readonly params: URLSearchParams;
}

/** The tab and period a line or stop page reads from its URL. */
const RECORD_VIEW_PARAMS = ['tab', 'grain', 'from', 'to'] as const;

/**
 * The record a result opens. On the map a result keeps map focus. From a line
 * page another line opens on the same tab and period; the same for stops.
 */
export function searchHitHref(hit: SearchTarget, from: SearchOrigin): string {
	if (hit.kind === 'page') return hit.id;
	if (hit.kind === 'vehicle' && from.path !== '/map')
		return `/vehicle/${encodeURIComponent(hit.id)}`;
	const record =
		from.path === '/map'
			? null
			: hit.kind === 'route'
				? { href: routeFor({ kind: 'line', id: hit.id }), page: '/lines/' }
				: hit.kind === 'stop'
					? { href: routeFor({ kind: 'stop', id: hit.id }), page: '/stop/' }
					: null;
	if (!record) return chromeSearchHref(hit, from.params, from.path === '/map' ? 'map' : 'all');
	const view = new URLSearchParams();
	if (from.path.startsWith(record.page)) {
		for (const key of RECORD_VIEW_PARAMS) {
			const value = from.params.get(key);
			if (value != null) view.set(key, value);
		}
	}
	const search = view.toString();
	return search ? `${record.href}?${search}` : record.href;
}

export function chromeSearchHref(
	result: SearchTarget,
	currentSearchParams: URLSearchParams = new URLSearchParams(),
	scope: ChromeSearchScope = 'all',
): string {
	const state = fromSearchParams(currentSearchParams);
	if (result.kind === 'route') {
		state.routes.add(result.id);
	} else if (result.kind === 'stop') {
		state.stops.add(result.id);
	} else if (result.kind === 'vehicle') {
		state.vehicles.add(result.id);
	}

	const canonicalFilters = new URLSearchParams(toSearchString(state));
	const searchParams =
		scope === 'map' ? new URLSearchParams(currentSearchParams) : canonicalFilters;
	if (scope === 'map') {
		for (const key of FILTER_SEARCH_PARAM_KEYS) searchParams.delete(key);
		for (const key of FILTER_SEARCH_PARAM_KEYS) {
			for (const value of canonicalFilters.getAll(key)) searchParams.append(key, value);
		}
	}
	if (result.kind === 'address') {
		const target = addressTargetFromResult(result);
		if (target) setNearTargetSearchParams(searchParams, target);
	} else {
		if (scope !== 'map') copyNearTargetSearchParams(currentSearchParams, searchParams);
		setMapFocusSearchParams(searchParams, result.kind as MapFocusKind, result.id);
	}

	const search = searchParams.toString();
	return search ? `/map?${search}` : '/map';
}

function addressResultId(address: GeocodeSuggestion): string {
	return mapNearId(address.lat, address.lon);
}

function addressTargetFromResult(result: Omit<SearchTarget, 'kind'>) {
	if (typeof result.lat === 'number' && typeof result.lon === 'number') {
		return {
			lat: result.lat,
			lon: result.lon,
			label: result.label ?? 'Selected place',
			precision: result.precision,
		};
	}

	const match = result.id.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
	if (!match) return null;

	const lat = Number(match[1]);
	const lon = Number(match[2]);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	return { lat, lon, label: result.label ?? 'Selected place', precision: result.precision };
}
