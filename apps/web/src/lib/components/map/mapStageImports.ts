export const mapStageImports = {
	maplibre: async () => {
		const [maplibre, { default: workerUrl }] = await Promise.all([
			import('maplibre-gl'),
			import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
		]);
		maplibre.setWorkerUrl(workerUrl);
		return maplibre;
	},
	css: () => import('maplibre-gl/dist/maplibre-gl.css'),
	pmtiles: () => import('pmtiles'),
};
