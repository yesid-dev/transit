import { labelsPort, manifestPort } from './r2.core';

function deferredPort<Module, Port extends object>(
	load: () => Promise<Module>,
	select: (module: Module) => Port,
	keys: { readonly [Key in keyof Port]: true },
): Port {
	const port = {} as Record<keyof Port, unknown>;
	for (const key of Object.keys(keys) as (keyof Port)[]) {
		port[key] = (...args: unknown[]) =>
			load().then((module) => {
				const method = select(module)[key] as (...methodArgs: unknown[]) => Promise<unknown>;
				return method(...args);
			});
	}
	return port as Port;
}

const loadLive = () => import('./r2.live');
const loadStatic = () => import('./r2.static');
const loadHistoric = () => import('./r2.historic');

export const r2Adapter = {
	manifest: manifestPort,
	labels: labelsPort,
	live: deferredPort(loadLive, (module) => module.livePort, {
		vehicles: true,
		trips: true,
		stopDepartures: true,
		alerts: true,
		network: true,
	}),
	static: deferredPort(loadStatic, (module) => module.staticPort, {
		routesIndex: true,
		route: true,
		stopsIndex: true,
		stop: true,
	}),
	historic: deferredPort(loadHistoric, (module) => module.historicPort, {
		historyIndex: true,
		networkHistoryIndex: true,
		lineHistoryDirectory: true,
		stopHistoryDirectory: true,
		lineHistoryIndex: true,
		stopHistoryIndex: true,
		networkHistoryPartition: true,
		lineHistoryPartition: true,
		stopHistoryPartition: true,
		alertArchiveIndex: true,
		alertArchivePage: true,
		networkTrend: true,
		hotspots: true,
		alertHistory: true,
		routeReliabilityIndex: true,
		routeReliability: true,
		stopReliability: true,
	}),
	basemap: deferredPort(loadStatic, (module) => module.basemapPort, { get: true }),
	provenance: deferredPort(
		() => import('./r2.provenance'),
		(module) => module.provenancePort,
		{ get: true },
	),
	dataHealth: deferredPort(
		() => import('./r2.dataHealth'),
		(module) => module.dataHealthPort,
		{ get: true },
	),
};
