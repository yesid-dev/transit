import { isInsideBounds } from '#lib/geocode/types.ts';

/** One clear, single-valued query parameter for the copied client camera. */
export const MAP_VIEW_PARAM = 'mapview';

/** The pinned renderer's lower bound; the provider-fit minimum is checked on application. */
export const MAP_VIEW_MIN_ZOOM = -2;
export const MAP_VIEW_MAX_ZOOM = 16;
export const MAP_VIEW_MAX_PITCH = 60;

export interface MapViewHint {
	readonly center: readonly [number, number];
	readonly zoom: number;
	readonly bearing: number;
	readonly pitch: number;
}

/** The actual captured camera, compactly. Never a guessed centre from a bounding box. */
export function serializeMapViewHint(view: MapViewHint): string {
	return [view.center[0], view.center[1], view.zoom, view.bearing, view.pitch]
		.map((value) => (value === 0 ? 0 : value))
		.join(',');
}

const PART = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu;

export interface MapViewRuntimeLimits {
	getMinZoom(): number;
	getMaxZoom(): number;
	getMinPitch(): number;
	getMaxPitch(): number;
}

/** A copied value must fit the actual receiving viewport, never a guessed provider-fit floor. */
export function mapViewHintWithinRuntime(hint: MapViewHint, map: MapViewRuntimeLimits): boolean {
	const minZoom = map.getMinZoom(),
		maxZoom = map.getMaxZoom();
	const minPitch = map.getMinPitch(),
		maxPitch = map.getMaxPitch();
	return (
		[minZoom, maxZoom, minPitch, maxPitch].every(Number.isFinite) &&
		hint.zoom >= minZoom &&
		hint.zoom <= maxZoom &&
		hint.pitch >= minPitch &&
		hint.pitch <= maxPitch
	);
}

/**
 * Reads one well-formed hint. Duplicates, extra parts, control characters, non-finite values,
 * positions outside the published panning area and camera values beyond the runtime limits are
 * ignored, never repaired.
 */
export function parseMapViewHint(
	params: URLSearchParams,
	publishedBounds?: readonly number[] | null,
): MapViewHint | null {
	if (params.getAll(MAP_VIEW_PARAM).length !== 1) return null;
	const raw = params.get(MAP_VIEW_PARAM);
	if (!raw) return null;
	const parts = raw.split(',');
	if (parts.length !== 5 || !parts.every((part) => PART.test(part))) return null;
	const values = parts.map(Number);
	if (!values.every(Number.isFinite)) return null;
	const [lon, lat, zoom, bearing, pitch] = values;
	if (!isInsideBounds(lat, lon, publishedBounds ?? [-180, -90, 180, 90])) return null;
	if (zoom < MAP_VIEW_MIN_ZOOM || zoom > MAP_VIEW_MAX_ZOOM) return null;
	if (bearing < -180 || bearing > 180) return null;
	if (pitch < 0 || pitch > MAP_VIEW_MAX_PITCH) return null;
	return { center: [lon, lat], zoom, bearing, pitch };
}

/** Writes the hint as one value, retaining every other query parameter. */
export function setMapViewHint(params: URLSearchParams, hint: MapViewHint): void {
	params.set(MAP_VIEW_PARAM, serializeMapViewHint(hint));
}
