import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import type { RecordFeatures } from './recordMap';

const sourceId = 'record-map';
const pointsId = 'record-map-stops';
const pointDetailId = 'record-map-stop-centres';
const segmentIds = [
	'record-map-no-data',
	'record-map-too-few',
	'record-map-no-live',
	'record-map-measured',
];
const allIds = [pointDetailId, pointsId, ...segmentIds];

export function attachRecordMap(
	map: MapLibreMap,
	features: RecordFeatures,
	onpick: (id: string) => void,
	network = false,
) {
	function draw() {
		if (map.getSource(sourceId)) return;
		map.addSource(sourceId, { type: 'geojson', data: features });
		[[1, 1.8], [3, 1.5], [5, 3], null].forEach((dash, state) => {
			map.addLayer({
				id: segmentIds[state]!,
				type: 'line',
				source: sourceId,
				filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'state'], state]],
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: {
					'line-color': ['get', 'colour'],
					'line-width': network
						? ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2, 16, state === 3 ? 5 : 4]
						: state === 3
							? 5
							: 4,
					'line-offset': network
						? ['interpolate', ['linear'], ['zoom'], 12, 0, 15, 3, 16, 5]
						: ['get', 'offset'],
					...(dash ? { 'line-dasharray': dash } : {}),
				},
			});
		});
		map.addLayer({
			id: pointsId,
			type: 'circle',
			source: sourceId,
			filter: ['==', ['geometry-type'], 'Point'],
			layout: { 'circle-sort-key': ['get', 'state'] },
			paint: {
				'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 15, 5],
				'circle-color': ['get', 'colour'],
				'circle-opacity': ['match', ['get', 'state'], 0, 0, 2, 0, 1],
				'circle-stroke-color': ['get', 'colour'],
				'circle-stroke-width': ['match', ['get', 'state'], 1, 0, 1.5],
			},
		});
		map.addLayer({
			id: pointDetailId,
			type: 'circle',
			source: sourceId,
			filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'state'], 2]],
			paint: { 'circle-color': ['get', 'colour'], 'circle-radius': 1.25 },
		});
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
