import { centerFromProviderBbox, type MapFitPadding } from '../../components/map/viewport';
import type { Manifest } from '#lib/v1/schemas/index.ts';
import type { PublicProvider } from '#lib/v1/providers.ts';

/** First valid published candidate, in priority order. */
function published(...candidates: Array<readonly number[] | null | undefined>) {
	return candidates.find((candidate) => centerFromProviderBbox(candidate) !== null);
}

/** Catalogue framing, then the manifest's service bounds; none valid means no camera. */
export function mapCameraFraming({
	manifest,
	provider,
}: {
	manifest: Pick<Manifest, 'bbox'>;
	provider?: Pick<PublicProvider, 'fit_bounds' | 'max_bounds'> | null;
}) {
	const bounds = published(provider?.fit_bounds, manifest.bbox);
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
