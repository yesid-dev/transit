import { FILTER_SEARCH_PARAM_KEYS, toSearchParams, type FilterState } from '#lib/filters/index.ts';
import { MAP_FOCUS_PARAM } from '#lib/search/mapFocus.ts';
import { clearNearTargetSearchParams } from '#lib/search/mapNear.ts';
import { MAP_VIEW_PARAM, setMapViewHint, type MapViewHint } from './mapViewHint';

/**
 * The link a reader copies with a report list: this provider and locale, the live filters in
 * force, and the captured client camera. Record periods, explicit focus, near-me targets and any
 * earlier camera hint are cleared, so reopening it describes the live view only.
 */
export function buildMapReportLiveViewHref(
	base: URL,
	filter: FilterState,
	camera: MapViewHint | null,
	providerId: string,
): string | null {
	if (!camera) return null;
	const url = new URL(base.href);
	for (const key of FILTER_SEARCH_PARAM_KEYS) url.searchParams.delete(key);
	for (const key of ['generation', 'published', 'method', 'edition']) url.searchParams.delete(key);
	url.searchParams.delete(MAP_FOCUS_PARAM);
	url.searchParams.delete(MAP_VIEW_PARAM);
	clearNearTargetSearchParams(url.searchParams);
	const live = toSearchParams({
		routes: filter.routes,
		stops: filter.stops,
		trips: filter.trips,
		vehicles: filter.vehicles,
		showOutOfService: filter.showOutOfService,
		status: filter.status,
		occupancy: filter.occupancy,
		entities: filter.entities,
		alerts: filter.alerts,
		mapReadings: filter.mapReadings,
	});
	for (const [key, value] of live) url.searchParams.append(key, value);
	url.searchParams.set('provider', providerId);
	setMapViewHint(url.searchParams, camera);
	return url.href;
}
