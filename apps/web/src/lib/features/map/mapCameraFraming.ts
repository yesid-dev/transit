import { centerFromProviderBbox, type MapFitPadding } from '../../components/map/viewport';
import type { Manifest } from '#lib/v1/schemas/index.ts';
import type { PublicProvider } from '#lib/v1/providers.ts';
import type { StopIndexEntry } from '#lib/v1/schemas/index.ts';

/** First valid published candidate, in priority order. */
function published(...candidates: Array<readonly number[] | null | undefined>) {
	return candidates.find((candidate) => centerFromProviderBbox(candidate) !== null);
}

function servedStopBounds(stops: readonly StopIndexEntry[], hasLiveLine?: (id: string) => boolean) {
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	for (const { lon, lat, routes } of stops) {
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
}: {
	manifest: Pick<Manifest, 'bbox'>;
	provider?: Pick<PublicProvider, 'fit_bounds' | 'max_bounds'> | null;
	stops?: readonly StopIndexEntry[];
	hasLiveLine?: (id: string) => boolean;
}) {
	const bounds =
		published(provider?.fit_bounds) ??
		published(servedStopBounds(stops, hasLiveLine), servedStopBounds(stops), manifest.bbox);
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
