import { centerFromProviderBbox, type MapFitPadding } from '../../components/map/viewport';
import type { Manifest } from '#lib/v1/schemas/index.ts';
import type { PublicProvider } from '#lib/v1/providers.ts';
import type { RouteDirection, StopIndexEntry } from '#lib/v1/schemas/index.ts';

/** First valid published candidate, in priority order. */
function published(...candidates: Array<readonly number[] | null | undefined>) {
	return candidates.find((candidate) => centerFromProviderBbox(candidate) !== null);
}

function servedStopBounds(
	stops: readonly StopIndexEntry[],
	routeIdsByStop: ReadonlyMap<string, readonly string[]>,
	hasLiveLine?: (id: string) => boolean,
) {
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	for (const { id, lon, lat, routes: publishedRoutes } of stops) {
		const routes = publishedRoutes?.length ? publishedRoutes : routeIdsByStop.get(id);
		if (!routes?.some((id) => !hasLiveLine || hasLiveLine(id))) continue;
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
		west = Math.min(west, lon);
		south = Math.min(south, lat);
		east = Math.max(east, lon);
		north = Math.max(north, lat);
	}
	return [west, south, east, north];
}

/** Prefer the declared service framing, then the network's served stops. */
export function mapCameraFraming({
	manifest,
	provider,
	stops = [],
	hasLiveLine,
	routeDirections,
}: {
	manifest: Pick<Manifest, 'bbox'>;
	provider?: Pick<PublicProvider, 'fit_bounds' | 'max_bounds'> | null;
	stops?: readonly StopIndexEntry[];
	hasLiveLine?: (id: string) => boolean;
	routeDirections?: Readonly<Record<string, readonly Pick<RouteDirection, 'stops'>[]>>;
}) {
	let bounds = published(provider?.fit_bounds);
	if (!bounds) {
		const routeIdsByStop = new Map<string, string[]>();
		for (const [id, directions] of Object.entries(routeDirections ?? {})) {
			for (const direction of directions) {
				for (const stop of direction.stops ?? []) {
					const routes = routeIdsByStop.get(stop.id);
					if (routes) routes.push(id);
					else routeIdsByStop.set(stop.id, [id]);
				}
			}
		}
		bounds = published(
			servedStopBounds(stops, routeIdsByStop, hasLiveLine),
			servedStopBounds(stops, routeIdsByStop),
			manifest.bbox,
		);
	}
	const center = centerFromProviderBbox(bounds);
	if (!bounds || !center) return null;
	return {
		bounds,
		maxBounds: published(provider?.max_bounds, manifest.bbox) ?? bounds,
		center,
	};
}

/** Hydration/poster fallback; the live camera uses measured chrome insets. */
export function deriveMapFitPadding(isDesktopLayout: boolean, _mapWidthPx: number): MapFitPadding {
	return isDesktopLayout
		? { top: 160, bottom: 72, left: 280, right: 16 }
		: { top: 160, bottom: 112, left: 16, right: 16 };
}
