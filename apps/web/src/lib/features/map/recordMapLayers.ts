import type {
	ExpressionSpecification,
	LineLayerSpecification,
	Map as MapLibreMap,
	MapMouseEvent,
} from 'maplibre-gl';
import {
	recordCorridorWidths,
	recordStopRadii,
	recordUnmeasuredLine,
	type RecordFeatures,
	type RecordUnderlay,
} from './recordMap';
import {
	RECORD_EXTRUSION_CAP_ID,
	RECORD_EXTRUSION_ID,
	type RecordExtrusions,
} from './recordExtrusions';

const sourceId = 'record-map';
const underlaySourceId = 'record-map-underlay';
const underlayLineId = 'record-map-underlay-lines';
const underlayPointId = 'record-map-underlay-points';
const pointsId = 'record-map-stops';
const pointDetailId = 'record-map-stop-centres';
const outlineId = 'record-map-corridor-outline';
const approximateId = 'record-map-approximate-path';
const segmentIds = [
	'record-map-no-data',
	'record-map-too-few',
	'record-map-no-live',
	'record-map-measured',
];
const allIds = [
	RECORD_EXTRUSION_ID,
	RECORD_EXTRUSION_CAP_ID,
	pointDetailId,
	pointsId,
	...segmentIds,
];
const recordOrder: ExpressionSpecification = [
	'+',
	['*', ['get', 'state'], 5],
	['coalesce', ['get', 'step'], 0],
];

const measured: ExpressionSpecification = ['==', ['get', 'state'], 3];

function rampSize(
	[first, second, third, fourth, fifth]: readonly [number, number, number, number, number],
	extra = 0,
): ExpressionSpecification {
	return [
		'match',
		['get', 'step'],
		0,
		first + extra,
		1,
		second + extra,
		2,
		third + extra,
		3,
		fourth + extra,
		fifth + extra,
	];
}

function corridorWidth(network: boolean, extra = 0): ExpressionSpecification {
	return network
		? [
				'interpolate',
				['linear'],
				['zoom'],
				10,
				rampSize(recordCorridorWidths.network, extra),
				16,
				rampSize(recordCorridorWidths.detail, extra),
			]
		: rampSize(recordCorridorWidths.detail, extra);
}

export function attachRecordMap(
	map: MapLibreMap,
	features: RecordFeatures,
	onpick: (id: string) => void,
	{
		network,
		waits,
		outline,
		extrusions,
		capColour,
		underlay,
		underlayColour,
	}: {
		network: boolean;
		waits: boolean;
		outline: string;
		extrusions?: RecordExtrusions;
		capColour: string;
		/** The rest of a capped overview, drawn thin and neutral under the coloured worst. */
		underlay?: RecordUnderlay;
		underlayColour?: string;
	},
) {
	function draw() {
		if (map.getSource(sourceId)) return;
		if (underlay?.features.length && underlayColour && !map.getSource(underlaySourceId)) {
			map.addSource(underlaySourceId, { type: 'geojson', data: underlay });
			map.addLayer({
				id: underlayLineId,
				type: 'line',
				source: underlaySourceId,
				filter: ['==', ['geometry-type'], 'LineString'],
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: { 'line-color': underlayColour, 'line-width': 0.75, 'line-opacity': 0.55 },
			});
			map.addLayer({
				id: underlayPointId,
				type: 'circle',
				source: underlaySourceId,
				filter: ['==', ['geometry-type'], 'Point'],
				paint: { 'circle-color': underlayColour, 'circle-radius': 1.25, 'circle-opacity': 0.55 },
			});
		}
		map.addSource(sourceId, { type: 'geojson', data: features });
		for (const [state, id] of segmentIds.entries()) {
			const dash = recordUnmeasuredLine.dashes[state];
			const layer: LineLayerSpecification = {
				id,
				type: 'line',
				source: sourceId,
				filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'state'], state]],
				layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': recordOrder },
				paint: {
					'line-color': ['get', 'colour'],
					'line-width': dash
						? ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, recordUnmeasuredLine.width]
						: corridorWidth(network),
					'line-offset': network
						? ['interpolate', ['linear'], ['zoom'], 12, 0, 15, 3, 16, 5]
						: ['get', 'offset'],
					...(dash ? { 'line-dasharray': [...dash] } : {}),
				},
			};
			if (!dash) {
				map.addLayer({
					...layer,
					id: outlineId,
					paint: { ...layer.paint, 'line-color': outline, 'line-width': corridorWidth(network, 2) },
				});
			}
			map.addLayer(layer);
		}
		map.addLayer({
			id: approximateId,
			type: 'line',
			source: sourceId,
			filter: ['==', ['get', 'approximate'], true],
			paint: {
				'line-color': outline,
				'line-width': 1.5,
				'line-offset': network
					? ['interpolate', ['linear'], ['zoom'], 12, 5, 15, 8, 16, 10]
					: ['+', ['get', 'offset'], 5],
				'line-dasharray': [1, 3],
			},
		});
		map.addLayer({
			id: pointsId,
			type: 'circle',
			source: sourceId,
			filter: ['==', ['geometry-type'], 'Point'],
			layout: { 'circle-sort-key': recordOrder },
			paint: {
				'circle-radius': waits
					? [
							'interpolate',
							['linear'],
							['zoom'],
							9,
							['case', measured, rampSize(recordStopRadii.waitsNetwork), 3.75],
							15,
							['case', measured, rampSize(recordStopRadii.detail), 5],
						]
					: [
							'interpolate',
							['linear'],
							['zoom'],
							// Under zoom 11 thousands of stops share the screen: small dots, no ring.
							10,
							['case', measured, rampSize(recordStopRadii.overview), 1.5],
							12,
							['case', measured, rampSize(recordStopRadii.network), 3.75],
							15,
							['case', measured, rampSize(recordStopRadii.detail), 5],
						],
				'circle-color': ['get', 'colour'],
				'circle-opacity': ['match', ['get', 'state'], 0, 0, 2, 0, 1],
				'circle-stroke-color': ['match', ['get', 'state'], 3, outline, ['get', 'colour']],
				'circle-stroke-width': [
					'interpolate',
					['linear'],
					['zoom'],
					10,
					['match', ['get', 'state'], 1, 0, 3, 0, 0.75],
					12,
					['match', ['get', 'state'], 1, 0, 3, waits ? 0.65 : 1, 1.5],
				],
			},
		});
		map.addLayer({
			id: pointDetailId,
			type: 'circle',
			source: sourceId,
			filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'state'], 2]],
			paint: {
				'circle-color': ['get', 'colour'],
				'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 15, 2.25],
			},
		});
		if (extrusions?.features.length) {
			map.addSource(RECORD_EXTRUSION_ID, { type: 'geojson', data: extrusions });
			map.addLayer({
				id: RECORD_EXTRUSION_ID,
				type: 'fill-extrusion',
				source: RECORD_EXTRUSION_ID,
				paint: {
					'fill-extrusion-color': ['get', 'colour'],
					'fill-extrusion-height': ['get', 'bodyHeight'],
					'fill-extrusion-vertical-gradient': false,
				},
			});
			map.addLayer({
				id: RECORD_EXTRUSION_CAP_ID,
				type: 'fill-extrusion',
				source: RECORD_EXTRUSION_ID,
				filter: ['==', ['get', 'capped'], true],
				paint: {
					'fill-extrusion-color': capColour,
					'fill-extrusion-base': ['get', 'bodyHeight'],
					'fill-extrusion-height': ['get', 'height'],
					'fill-extrusion-vertical-gradient': false,
				},
			});
		}
	}
	function pick(event: MapMouseEvent) {
		const layers = allIds.filter((id) => map.getLayer(id));
		if (!layers.length) return;
		const { x, y } = event.point;
		const exact = network ? map.queryRenderedFeatures(event.point, { layers })[0] : undefined;
		const hit =
			exact ??
			map.queryRenderedFeatures(
				[
					[x - 5, y - 5],
					[x + 5, y + 5],
				],
				{ layers },
			)[0];
		const id = hit?.properties?.id;
		if (typeof id === 'string') onpick(id);
	}
	if (map.isStyleLoaded()) draw();
	map.on('style.load', draw);
	map.on('idle', draw);
	map.on('click', pick);
	return () => {
		map.off('style.load', draw);
		map.off('idle', draw);
		map.off('click', pick);
		for (const id of allIds) if (map.getLayer(id)) map.removeLayer(id);
		if (map.getLayer(outlineId)) map.removeLayer(outlineId);
		if (map.getLayer(approximateId)) map.removeLayer(approximateId);
		if (map.getSource(RECORD_EXTRUSION_ID)) map.removeSource(RECORD_EXTRUSION_ID);
		if (map.getSource(sourceId)) map.removeSource(sourceId);
		for (const id of [underlayLineId, underlayPointId]) if (map.getLayer(id)) map.removeLayer(id);
		if (map.getSource(underlaySourceId)) map.removeSource(underlaySourceId);
	};
}
