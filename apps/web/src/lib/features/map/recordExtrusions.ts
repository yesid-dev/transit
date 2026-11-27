import type { RecordFeatures } from './recordMap';

export const RECORD_EXTRUSION_ID = 'record-map-extrusions';

type Coordinate = [number, number];
type Polygon = Coordinate[][];

export interface RecordExtrusions {
	type: 'FeatureCollection';
	features: {
		type: 'Feature';
		geometry: { type: 'MultiPolygon'; coordinates: Polygon[] };
		properties: { id: string; colour: string; height: number };
	}[];
}

const METRES_PER_LATITUDE_DEGREE = 111_320;
const HALF_WIDTH_METRES = 12;
const HEIGHT_SCALE = 24;

function corridorStrip(from: Coordinate, to: Coordinate): Polygon | null {
	const latitude = ((from[1] + to[1]) * Math.PI) / 360;
	const longitudeScale = METRES_PER_LATITUDE_DEGREE * Math.cos(latitude);
	if (longitudeScale < 1) return null;
	const east = (to[0] - from[0]) * longitudeScale;
	const north = (to[1] - from[1]) * METRES_PER_LATITUDE_DEGREE;
	const length = Math.hypot(east, north);
	if (!Number.isFinite(length) || length === 0) return null;
	const offsetX = (-north * HALF_WIDTH_METRES) / (length * longitudeScale);
	const offsetY = (east * HALF_WIDTH_METRES) / (length * METRES_PER_LATITUDE_DEGREE);
	const left: Coordinate = [from[0] + offsetX, from[1] + offsetY];
	return [
		[
			left,
			[from[0] - offsetX, from[1] - offsetY],
			[to[0] - offsetX, to[1] - offsetY],
			[to[0] + offsetX, to[1] + offsetY],
			left,
		],
	];
}

export function recordExtrusions(
	drawn: RecordFeatures,
	valueFor: (id: string) => number | null | undefined,
): RecordExtrusions {
	const features: RecordExtrusions['features'] = [];
	for (const { geometry, properties } of drawn.features) {
		if (geometry.type !== 'LineString' || properties.state !== 3) continue;
		const value = valueFor(properties.id);
		if (value == null || !Number.isFinite(value) || value <= 0) continue;
		const polygons: Polygon[] = [];
		for (let index = 1; index < geometry.coordinates.length; index++) {
			const strip = corridorStrip(geometry.coordinates[index - 1], geometry.coordinates[index]);
			if (strip) polygons.push(strip);
		}
		if (polygons.length === 0) continue;
		features.push({
			type: 'Feature',
			geometry: { type: 'MultiPolygon', coordinates: polygons },
			properties: {
				id: properties.id,
				colour: properties.colour,
				height: HEIGHT_SCALE * Math.sqrt(value),
			},
		});
	}
	return { type: 'FeatureCollection', features };
}
