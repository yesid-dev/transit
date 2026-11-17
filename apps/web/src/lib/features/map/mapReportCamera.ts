import { LngLat } from 'maplibre-gl';

/** The captured camera a report snapshot belongs to. */
export interface MapReportCamera {
	readonly center: readonly [number, number];
	readonly zoom: number;
	readonly bearing: number;
	readonly pitch: number;
	/** CSS pixels of the actual canvas, never a guessed viewport. */
	readonly width: number;
	readonly height: number;
	/** The rotated/pitched envelope, for disclosure and CSV only, never for inclusion. */
	readonly bbox: {
		readonly west: number;
		readonly south: number;
		readonly east: number;
		readonly north: number;
	};
	/** The live map's own projection at capture time. */
	readonly project: (coord: readonly [number, number]) => {
		readonly x: number;
		readonly y: number;
	};
}

/** The map facts a report capture needs, structurally satisfied by MapLibre's Map. */
export interface MapReportCameraSource {
	project(coord: [number, number]): { readonly x: number; readonly y: number };
	/** Pinned MapLibre renderer access is isolated here, never retained as a live projection. */
	readonly _camera?: {
		readonly transform: {
			clone(): {
				locationToScreenPoint(coord: LngLat): { readonly x: number; readonly y: number };
			};
		};
	};
	getCenter(): { readonly lng: number; readonly lat: number };
	getZoom(): number;
	getBearing(): number;
	getPitch(): number;
	getCanvas(): { readonly clientWidth: number; readonly clientHeight: number } | null;
	getBounds(): {
		readonly getWest: () => number;
		readonly getSouth: () => number;
		readonly getEast: () => number;
		readonly getNorth: () => number;
	};
}

/**
 * Copies the settled camera once. Null means no truthful report scope: before the map exists,
 * while it has no box, or after a recovery replaced its canvas.
 */
export function captureMapReportCamera(map: MapReportCameraSource | null): MapReportCamera | null {
	if (!map) return null;
	const canvas = map.getCanvas();
	const width = canvas?.clientWidth;
	const height = canvas?.clientHeight;
	if (!isPositive(width) || !isPositive(height)) return null;
	const center = map.getCenter();
	const zoom = map.getZoom();
	const bearing = map.getBearing();
	const pitch = map.getPitch();
	if (![center.lng, center.lat, zoom, bearing, pitch].every(Number.isFinite)) return null;
	const bounds = map.getBounds();
	const bbox = {
		west: bounds.getWest(),
		south: bounds.getSouth(),
		east: bounds.getEast(),
		north: bounds.getNorth(),
	};
	if (![bbox.west, bbox.south, bbox.east, bbox.north].every(Number.isFinite)) return null;
	// MapLibre 6.4's project() delegates to this renderer transform. Its clone retains
	// padding, rotation and pitch without consulting a subsequently moving camera.
	// Fail closed if an upgraded renderer no longer supplies the required capability.
	const projection = map._camera?.transform.clone();
	if (!projection) return null;
	return {
		center: [center.lng, center.lat],
		zoom,
		bearing,
		pitch,
		width,
		height,
		bbox,
		project: (coord) => {
			const point = projection.locationToScreenPoint(new LngLat(coord[0], coord[1]));
			return { x: point.x, y: point.y };
		},
	};
}

function isPositive(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The included rectangle is the actual captured canvas: rotation and pitch already determine the
 * projection, so corners admitted by the envelope alone stay out.
 */
export function isCoordinateInCapturedView(
	camera: MapReportCamera,
	coord: readonly [number, number],
): boolean {
	if (![coord[0], coord[1]].every(Number.isFinite)) return false;
	const point = camera.project(coord);
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
	return point.x >= 0 && point.x <= camera.width && point.y >= 0 && point.y <= camera.height;
}

/** Stable camera identity for snapshot comparison, without any animation state. */
export function mapReportCameraKey(camera: MapReportCamera | null): string {
	if (!camera) return 'no-view';
	return [
		camera.center[0],
		camera.center[1],
		camera.zoom,
		camera.bearing,
		camera.pitch,
		camera.width,
		camera.height,
	].join(',');
}
