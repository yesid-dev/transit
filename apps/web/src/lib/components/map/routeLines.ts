import type {
	Map as MapLibreMap,
	GeoJSONSource,
	LayerSpecification,
	ExpressionSpecification,
} from 'maplibre-gl';
import type { RouteDirection, RouteFile } from '#lib/v1/schemas/index.ts';
import { routeDirectionVariants, type RouteDirectionVariant } from './routeDirection';
import { resolveColor } from './vehicleSprites';

export const ROUTE_LINE_SOURCE = 'route-lines';
export const ROUTE_LINE_CASING_LAYER = 'route-lines-casing';
export const ROUTE_LINE_LAYER = 'route-lines';
export const ROUTE_LINE_HIT_LAYER = 'route-lines-hit';

interface LineStringGeometry {
	type: 'LineString';
	coordinates: [number, number][];
}

interface RouteLineFeature {
	type: 'Feature';
	geometry: LineStringGeometry;
	properties: {
		id: string;
		route_id: string;
		route_long: string;
		direction: number;
		variant_key: string;
		headsign: string;
		terminal_label: string;
		selected: number;
		muted?: boolean;
		schedule_only?: boolean;
	};
}

interface RouteLineFC {
	type: 'FeatureCollection';
	features: RouteLineFeature[];
}

const EMPTY_FC: RouteLineFC = { type: 'FeatureCollection', features: [] };

function isLngLatPair(value: unknown): value is [number, number] {
	return (
		Array.isArray(value) &&
		value.length >= 2 &&
		typeof value[0] === 'number' &&
		typeof value[1] === 'number' &&
		Number.isFinite(value[0]) &&
		Number.isFinite(value[1])
	);
}

function lineString(direction: RouteDirection): LineStringGeometry | null {
	const shape = direction.shape;
	if (!shape || shape.type !== 'LineString' || !Array.isArray(shape.coordinates)) return null;
	const coordinates = shape.coordinates.filter(isLngLatPair);
	return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
}

export interface SelectedRouteLine {
	readonly id: string;
	readonly direction?: number | null;
	readonly variantKey?: string | null;
}

function isSelectedRouteLine(
	route: RouteFile,
	variant: RouteDirectionVariant,
	selected?: SelectedRouteLine | null,
): boolean {
	if (!selected || selected.id !== route.id) return false;
	if (selected.variantKey) return selected.variantKey === variant.key;
	return selected.direction == null || selected.direction === variant.dir;
}

export function toRouteLineFeatures(
	routes: readonly RouteFile[],
	selected?: SelectedRouteLine | null,
): RouteLineFC {
	const features: RouteLineFeature[] = [];

	for (const route of routes) {
		const drawable = routeDirectionVariants(route).flatMap((variant) => {
			const geometry = lineString(variant.direction);
			return geometry ? [{ variant, geometry }] : [];
		});
		const routeSelection =
			selected?.id === route.id
				? drawable.some(({ variant }) => isSelectedRouteLine(route, variant, selected))
					? selected
					: { id: route.id }
				: null;
		for (const { variant, geometry } of drawable) {
			const { direction } = variant;
			const highlighted = isSelectedRouteLine(route, variant, routeSelection);
			features.push({
				type: 'Feature',
				geometry,
				properties: {
					id: variant.featureId,
					route_id: route.id,
					route_long: route.long ?? '',
					direction: direction.dir,
					variant_key: variant.key,
					headsign: direction.headsign ?? '',
					terminal_label: variant.label,
					selected: highlighted ? 1 : 0,
					...(selected && !highlighted ? { muted: true } : {}),
					...(route.schedule_only ? { schedule_only: true } : {}),
				},
			});
		}
	}

	return { type: 'FeatureCollection', features };
}

export function addRouteLineSource(map: MapLibreMap): void {
	if (map.getSource(ROUTE_LINE_SOURCE)) return;
	map.addSource(ROUTE_LINE_SOURCE, { type: 'geojson', data: EMPTY_FC, promoteId: 'id' });
}

const LINE_WIDTH = [
	'interpolate',
	['linear'],
	['zoom'],
	9,
	['case', ['==', ['get', 'selected'], 1], 3.4, 2.2],
	12,
	['case', ['==', ['get', 'selected'], 1], 5.1, 3.6],
	15,
	['case', ['==', ['get', 'selected'], 1], 7, 5.2],
];
const CASING_WIDTH = [
	'interpolate',
	['linear'],
	['zoom'],
	9,
	['case', ['==', ['get', 'selected'], 1], 7.2, 5],
	12,
	['case', ['==', ['get', 'selected'], 1], 10, 7],
	15,
	['case', ['==', ['get', 'selected'], 1], 12.5, 9],
];
const HIT_WIDTH = ['interpolate', ['linear'], ['zoom'], 9, 16, 12, 20, 15, 26];

function lineLayout(): LayerSpecification['layout'] {
	return { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'selected'] };
}

function routeInk(): ExpressionSpecification {
	const selected = resolveColor('var(--accent-text)', 'rgb(255, 182, 39)');
	const network = resolveColor('var(--muted-foreground)', 'rgb(112, 120, 134)');
	return ['case', ['==', ['get', 'selected'], 1], selected, network];
}

export function addRouteLineLayers(map: MapLibreMap, beforeId?: string): void {
	if (map.getLayer(ROUTE_LINE_LAYER)) {
		retintRouteLineLayers(map);
		return;
	}
	const casing = resolveColor('var(--background)', 'rgb(20, 20, 20)');

	map.addLayer(
		{
			id: ROUTE_LINE_CASING_LAYER,
			type: 'line',
			source: ROUTE_LINE_SOURCE,
			layout: lineLayout(),
			paint: {
				'line-color': casing,
				'line-opacity': ['case', ['==', ['get', 'muted'], true], 0.2, 0.9],
				'line-width': CASING_WIDTH,
			},
		} as unknown as LayerSpecification,
		beforeId,
	);

	map.addLayer(
		{
			id: ROUTE_LINE_LAYER,
			type: 'line',
			source: ROUTE_LINE_SOURCE,
			layout: lineLayout(),
			paint: {
				'line-color': routeInk(),
				'line-opacity': ['case', ['==', ['get', 'muted'], true], 0.28, 0.95],
				'line-dasharray': [
					'case',
					['all', ['==', ['get', 'schedule_only'], true], ['==', ['get', 'selected'], 0]],
					['literal', [1.5, 2]],
					['literal', [1, 0]],
				],
				'line-width': LINE_WIDTH,
			},
		} as unknown as LayerSpecification,
		beforeId,
	);

	map.addLayer(
		{
			id: ROUTE_LINE_HIT_LAYER,
			type: 'line',
			source: ROUTE_LINE_SOURCE,
			layout: lineLayout(),
			paint: {
				'line-opacity': 0,
				'line-width': HIT_WIDTH,
			},
		} as unknown as LayerSpecification,
		beforeId,
	);
}

function retintRouteLineLayers(map: MapLibreMap): void {
	const casing = resolveColor('var(--background)', 'rgb(20, 20, 20)');
	map.setPaintProperty(ROUTE_LINE_CASING_LAYER, 'line-color', casing);
	map.setPaintProperty(ROUTE_LINE_LAYER, 'line-color', routeInk());
}

export function setRouteLines(
	map: MapLibreMap,
	routes: readonly RouteFile[],
	selected?: SelectedRouteLine | null,
): void {
	const src = map.getSource(ROUTE_LINE_SOURCE) as GeoJSONSource | undefined;
	src?.setData(
		toRouteLineFeatures(routes, selected) as unknown as Parameters<GeoJSONSource['setData']>[0],
	);
}
