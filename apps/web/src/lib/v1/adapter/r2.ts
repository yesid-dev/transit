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

export const r2Adapter = {
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
	basemap: deferredPort(loadStatic, (module) => module.basemapPort, { get: true }),
};
