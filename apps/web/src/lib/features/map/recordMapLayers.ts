import type { ExpressionSpecification, Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import {
	OTHER_STOPS_MIN_ZOOM,
	recordCorridorWidths,
	recordStopRadii,
	recordUnmeasuredLine,
	type RecordFeatures,
} from './recordMap';

const sourceId = 'record-map';
const pointsId = 'record-map-stops';
const pointDetailId = 'record-map-stop-centres';
const segmentIds = [
	'record-map-no-data',
	'record-map-too-few',
	'record-map-no-live',
	'record-map-measured',
];
const allIds = [
	pointDetailId,
	pointsId,
	`${pointDetailId}-other`,
	`${pointsId}-other`,
	...segmentIds,
];

function rampSize([first, second, third, fourth, fifth]: readonly [
	number,
	number,
	number,
	number,
	number,
]): ExpressionSpecification {
	return ['match', ['get', 'step'], 0, first, 1, second, 2, third, 3, fourth, fifth];
}

export function attachRecordMap(
	map: MapLibreMap,
	features: RecordFeatures,
	onpick: (id: string) => void,
	network = false,
) {
	function draw() {
		if (map.getSource(sourceId)) return;
		map.addSource(sourceId, { type: 'geojson', data: features });
		for (const [state, id] of segmentIds.entries()) {
			const dash = recordUnmeasuredLine.dashes[state];
			map.addLayer({
				id,
				type: 'line',
				source: sourceId,
				filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'state'], state]],
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: {
					'line-color': ['get', 'colour'],
					'line-width': dash
						? recordUnmeasuredLine.width
						: network
							? [
									'interpolate',
									['linear'],
									['zoom'],
									10,
									rampSize(recordCorridorWidths.network),
									16,
									rampSize(recordCorridorWidths.detail),
								]
							: rampSize(recordCorridorWidths.detail),
					'line-offset': network
						? ['interpolate', ['linear'], ['zoom'], 12, 0, 15, 3, 16, 5]
						: ['get', 'offset'],
					...(dash ? { 'line-dasharray': [...dash] } : {}),
				},
			});
		}
		for (const main of [true, false]) {
			const minzoom = main ? 0 : OTHER_STOPS_MIN_ZOOM;
			map.addLayer({
				id: main ? pointsId : `${pointsId}-other`,
				minzoom,
				type: 'circle',
				source: sourceId,
				filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'main'], main]],
				layout: { 'circle-sort-key': ['get', 'state'] },
				paint: {
					'circle-radius': [
						'interpolate',
						['linear'],
						['zoom'],
						9,
						['case', ['==', ['get', 'state'], 3], rampSize(recordStopRadii.network), 3],
						15,
						['case', ['==', ['get', 'state'], 3], rampSize(recordStopRadii.detail), 5],
					],
					'circle-color': ['get', 'colour'],
					'circle-opacity': ['match', ['get', 'state'], 0, 0, 2, 0, 1],
					'circle-stroke-color': ['get', 'colour'],
					'circle-stroke-width': ['match', ['get', 'state'], 1, 0, 1.5],
				},
			});
			map.addLayer({
				id: main ? pointDetailId : `${pointDetailId}-other`,
				minzoom,
				type: 'circle',
				source: sourceId,
				filter: [
					'all',
					['==', ['geometry-type'], 'Point'],
					['==', ['get', 'main'], main],
					['==', ['get', 'state'], 2],
				],
				paint: { 'circle-color': ['get', 'colour'], 'circle-radius': 1.25 },
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
		if (map.getSource(sourceId)) map.removeSource(sourceId);
	};
}
