import type { MapReportCamera } from './mapReportCamera';
import type { RecordFeatures, RecordMark } from './recordMap';

export const RECORD_EXTRUSION_ID = 'record-map-extrusions';
export const RECORD_EXTRUSION_CAP_ID = 'record-map-extrusion-caps';

type Coordinate = [number, number];
type Polygon = Coordinate[][];

export interface RecordExtrusions {
	type: 'FeatureCollection';
	features: {
		type: 'Feature';
		geometry: { type: 'MultiPolygon'; coordinates: Polygon[] };
		properties: { id: string; colour: string; height: number; bodyHeight: number; capped: boolean };
	}[];
}

const METRES_PER_LATITUDE_DEGREE = 111_320;
const HALF_WIDTH_METRES = 12;
const EARTH_CIRCUMFERENCE_METRES = 40_075_017;

interface HeightScale {
	seconds: number;
	metres: number;
}

export function recordHeightScale(
	inView: readonly Pick<RecordMark, 'state' | 'value'>[],
	camera: Pick<MapReportCamera, 'center' | 'zoom' | 'height'>,
): HeightScale | null {
	const losses = inView
		.flatMap(({ state, value }) => (state === 3 && value != null && value > 0 ? [value] : []))
		.sort((a, b) => a - b);
	const seconds = losses[Math.ceil(losses.length * 0.95) - 1];
	if (!seconds) return null;
	const metresPerPixel =
		(EARTH_CIRCUMFERENCE_METRES * Math.cos((camera.center[1] * Math.PI) / 180)) /
		(512 * 2 ** camera.zoom);
	return { seconds, metres: metresPerPixel * Math.min(90, camera.height * 0.16) };
}

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
	scale: HeightScale,
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
		const capped = value > scale.seconds;
		const height = (Math.min(value, scale.seconds) / scale.seconds) * scale.metres;
		features.push({
			type: 'Feature',
			geometry: { type: 'MultiPolygon', coordinates: polygons },
			properties: {
				id: properties.id,
				colour: properties.colour,
				height,
				capped,
				bodyHeight: capped ? height * 0.88 : height,
			},
		});
	}
	return { type: 'FeatureCollection', features };
}
