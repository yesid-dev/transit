import {
	isCoordinateInCapturedView,
	isLineInCapturedView,
	type MapReportCamera,
} from './mapReportCamera';

type Coordinate = readonly [number, number];
type Geometry =
	| { type: 'Point'; coordinates: Coordinate }
	| { type: 'LineString'; coordinates: readonly Coordinate[] };

/**
 * Whether a Record mark shows on the captured canvas. A camera with no rotation or tilt shows
 * exactly its bounds, so thousands of readings are checked without projecting each one; a
 * rotated or tilted camera projects them.
 */
export function isMarkInCapturedView(camera: MapReportCamera, geometry: Geometry): boolean {
	const flat = camera.bearing === 0 && camera.pitch === 0;
	const { west, south, east, north } = camera.bbox;
	const inside = ([lon, lat]: Coordinate) =>
		lon >= west && lon <= east && lat >= south && lat <= north;
	if (geometry.type === 'Point')
		return flat
			? inside(geometry.coordinates)
			: isCoordinateInCapturedView(camera, geometry.coordinates);
	if (!flat) return isLineInCapturedView(camera, geometry.coordinates);
	if (geometry.coordinates.some(inside)) return true;
	// Both ends outside: the stretch can still cross the view.
	const lons = geometry.coordinates.map(([lon]) => lon);
	const lats = geometry.coordinates.map(([, lat]) => lat);
	if (
		Math.max(...lons) < west ||
		Math.min(...lons) > east ||
		Math.max(...lats) < south ||
		Math.min(...lats) > north
	)
		return false;
	return isLineInCapturedView(camera, geometry.coordinates);
}
